import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { ConfigError, normalizeBasePath } from "./config.ts";
import { publicError } from "./errors.ts";
import type { BrowserHost } from "./browser/host.ts";
import { Gateway, type GatewayResponse } from "./gateway.ts";
import { containsCredentialKey, isPlainObject, ownKeys } from "./json-safety.ts";
import { resolveGatewayToken } from "./token.ts";
import { gatewayTokensMatch } from "./token.ts";
import type { AdapterKind, AuditRecord, StreamEvent, Subscriber } from "./types.ts";

const MAX_BODY_BYTES = 65_536;
const SESSION_ID = /^ses_[0-9a-f]{32}$/;

export interface AppOptions {
  adapter: AdapterKind;
  token?: string | null;
  basePath?: string;
  mockSettleMs?: number;
  audit?: (record: AuditRecord) => void;
  browserHostRunning?: boolean;
  browserHost?: BrowserHost | null;
}

export interface GatewayApp {
  basePath: string;
  gateway: Gateway;
  server: Server;
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
}

type RouteMatch =
  | { kind: "invalid" }
  | { kind: "unknown" }
  | { kind: "health"; methods: readonly string[] }
  | { kind: "sessions"; methods: readonly string[] }
  | { kind: "session"; methods: readonly string[]; sessionId: string }
  | { kind: "actions"; methods: readonly string[]; sessionId: string }
  | { kind: "events"; methods: readonly string[]; sessionId: string };

export function createGatewayApp(options: AppOptions): GatewayApp {
  const resolved = resolveGatewayToken(options.token ?? undefined);
  if (!resolved.ok) {
    throw new ConfigError(resolved.message);
  }
  const configuredToken = resolved.token;
  const audit = options.audit ?? (() => undefined);
  if (resolved.placeholderIgnored) {
    audit({ event: "placeholder_token_ignored", code: "auth_not_configured" });
  }
  const basePath = normalizeBasePath(options.basePath);
  const gateway = new Gateway({
    adapter: options.adapter,
    token: configuredToken,
    mockSettleMs: options.mockSettleMs,
    audit,
    browserHostRunning: options.browserHostRunning,
    browserHost: options.browserHost,
  });
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 501, { error: publicError("unsupported") });
      }
      audit({ event: "internal_error", code: "unsupported", httpStatus: 501 });
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.timeout = 0;
  server.keepAliveTimeout = 200;

  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    basePath,
    gateway,
    server,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Gateway failed to listen."));
            return;
          }
          resolve(address.port);
        });
      });
    },
    async close() {
      await gateway.shutdown();
      server.closeAllConnections();
      for (const socket of sockets) {
        socket.destroy();
      }
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const matched = matchRoute(basePath, req.url);
    if (matched.kind === "invalid") {
      sendJson(res, 400, { error: publicError("invalid_path") });
      return;
    }
    if (matched.kind === "unknown") {
      sendJson(res, 404, { error: publicError("not_found") });
      return;
    }
    if (!matched.methods.includes(req.method ?? "")) {
      res.setHeader("allow", matched.methods.join(", "));
      sendJson(res, 405, { error: publicError("method_not_allowed") });
      return;
    }
    if (matched.kind === "health") {
      sendJson(res, 200, gateway.health());
      return;
    }

    const auth = authorize(req.headers.authorization, configuredToken);
    if (!auth.ok) {
      const status = auth.code === "auth_not_configured" ? 503 : 401;
      if (status === 401) {
        res.setHeader("www-authenticate", 'Bearer realm="remote-claude-gateway"');
      }
      audit({ event: "gateway_auth_failed", code: auth.code, httpStatus: status });
      sendJson(res, status, { error: publicError(auth.code) });
      return;
    }

    if (matched.kind === "sessions") {
      const body = await readJson(req);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      if (containsCredentialKey(body.value)) {
        audit({ event: "payload_rejected", code: "payload_rejected", httpStatus: 400 });
        sendJson(res, 400, { error: publicError("payload_rejected") });
        return;
      }
      if (!isPlainObject(body.value) || ownKeys(body.value).length !== 0) {
        sendJson(res, 400, { error: publicError("invalid_action") });
        return;
      }
      writeGateway(res, await gateway.createSession());
      return;
    }

    if (!SESSION_ID.test(matched.sessionId)) {
      sendJson(res, 404, { error: publicError("session_not_found") });
      return;
    }

    if (matched.kind === "session" && req.method === "GET") {
      writeGateway(res, gateway.getSession(matched.sessionId));
      return;
    }
    if (matched.kind === "session" && req.method === "DELETE") {
      writeGateway(res, await gateway.deleteSession(matched.sessionId));
      return;
    }
    if (matched.kind === "actions") {
      const body = await readJson(req);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      writeGateway(res, await gateway.performAction(matched.sessionId, body.value));
      return;
    }
    const lastEventId = headerValue(req.headers["last-event-id"]);
    const opened = gateway.openEvents(matched.sessionId, lastEventId);
    if (opened.kind !== "stream") {
      writeGateway(res, opened);
      return;
    }
    writeSse(req, res, opened.replayAndSubscribe);
  }
}

function authorize(
  header: string | string[] | undefined,
  token: string | null,
): { ok: true } | { ok: false; code: "auth_not_configured" | "auth_required" | "auth_invalid" } {
  if (!token) {
    return { ok: false, code: "auth_not_configured" };
  }
  if (header === undefined) {
    return { ok: false, code: "auth_required" };
  }
  if (Array.isArray(header)) {
    return { ok: false, code: "auth_invalid" };
  }
  const match = /^Bearer (\S+)$/i.exec(header);
  if (!match || !gatewayTokensMatch(match[1], token)) {
    return { ok: false, code: "auth_invalid" };
  }
  return { ok: true };
}

function matchRoute(basePath: string, rawUrl: string | undefined): RouteMatch {
  const pathname = normalizedPathname(rawUrl);
  if (pathname === null) {
    return { kind: "invalid" };
  }
  const relative = stripBase(pathname, basePath);
  if (relative === null) {
    return { kind: "unknown" };
  }
  const parts = relative.split("/").filter((part) => part.length > 0);
  if (parts.length === 1 && parts[0] === "health") {
    return { kind: "health", methods: ["GET"] };
  }
  if (parts.length === 1 && parts[0] === "sessions") {
    return { kind: "sessions", methods: ["POST"] };
  }
  if (parts.length === 2 && parts[0] === "sessions") {
    return { kind: "session", methods: ["GET", "DELETE"], sessionId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "actions") {
    return { kind: "actions", methods: ["POST"], sessionId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "events") {
    return { kind: "events", methods: ["GET"], sessionId: parts[1] };
  }
  return { kind: "unknown" };
}

function normalizedPathname(rawUrl: string | undefined): string | null {
  if (!rawUrl || !rawUrl.startsWith("/")) {
    return null;
  }
  const stop = rawUrl.search(/[?#]/);
  const pathname = stop === -1 ? rawUrl : rawUrl.slice(0, stop);
  if (pathname.includes("\\") || pathname.includes("\0") || pathname.includes("@")) {
    return null;
  }
  const segments = pathname.split("/");
  if (segments[0] !== "") {
    return null;
  }
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0 || segment === "." || segment === ".." || segment.includes("%")) {
      return null;
    }
  }
  return pathname;
}

function stripBase(pathname: string, basePath: string): string | null {
  if (!basePath) {
    return pathname;
  }
  if (pathname === basePath) {
    return "/";
  }
  const prefix = `${basePath}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  return pathname.slice(basePath.length);
}

async function readJson(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: ReturnType<typeof publicError> }> {
  const declared = headerValue(req.headers["content-length"]);
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: publicError("payload_too_large") };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        return { ok: false, status: 413, error: publicError("payload_too_large") };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, status: 400, error: publicError("invalid_json") };
  }
  if (size === 0) {
    return { ok: true, value: {} };
  }
  const contentType = headerValue(req.headers["content-type"])?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return { ok: false, status: 400, error: publicError("invalid_json") };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, error: publicError("invalid_json") };
  }
}

function writeGateway(res: ServerResponse, result: GatewayResponse): void {
  if (result.kind === "empty") {
    res.writeHead(204, securityHeaders());
    res.end();
    return;
  }
  if (result.kind === "json") {
    sendJson(res, result.httpStatus, result.body);
    return;
  }
  sendJson(res, 501, { error: publicError("unsupported") });
}

function writeSse(
  req: IncomingMessage,
  res: ServerResponse,
  attach: (subscriber: Subscriber) => () => void,
): void {
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  res.write(":\n\n");
  let closed = false;
  let unsubscribe: () => void = () => undefined;
  const finish = () => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
    if (!res.writableEnded) {
      res.end();
    }
  };
  const subscriber: Subscriber = {
    send(event: StreamEvent) {
      if (closed || res.writableEnded) {
        return;
      }
      res.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    close: finish,
  };
  unsubscribe = attach(subscriber);
  res.socket?.setNoDelay(true);
  // Socket close is the client disconnect. Do not use the request "close"
  // event: that also fires when a request body has been read.
  res.socket?.on("close", finish);
  res.on("error", finish);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
