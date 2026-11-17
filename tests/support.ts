import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";
import { createGatewayApp } from "../server/src/http.ts";
import type { AdapterKind, AuditRecord } from "../server/src/types.ts";

const dispatcher = new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 });
setGlobalDispatcher(dispatcher);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  undiciFetch(input as never, init as never)) as typeof fetch;

export interface RunningGateway {
  token: string | null;
  origin: string;
  audit: AuditRecord[];
  url(pathname: string): string;
  close(): Promise<void>;
}

export async function startGateway(options: {
  adapter: AdapterKind;
  token?: string | null;
  basePath?: string;
  mockSettleMs?: number;
}): Promise<RunningGateway> {
  const token =
    options.token === undefined ? `test-only-${randomBytes(16).toString("hex")}` : options.token;
  const audit: AuditRecord[] = [];
  const app = createGatewayApp({
    adapter: options.adapter,
    token,
    basePath: options.basePath,
    mockSettleMs: options.mockSettleMs ?? 250,
    audit: (record) => audit.push(record),
  });
  const port = await app.listen(0, "127.0.0.1");
  return {
    token,
    origin: `http://127.0.0.1:${port}`,
    audit,
    url(pathname: string) {
      return `http://127.0.0.1:${port}${app.basePath}${pathname}`;
    },
    close: () => app.close(),
  };
}

export function authHeaders(token: string | null, extra?: Record<string, string>): Record<string, string> {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export async function readJson(response: Response): Promise<{ status: number; body: any; text: string }> {
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    body = JSON.parse(text) as unknown;
  }
  return { status: response.status, body, text };
}

export interface SseConnection {
  status: number;
  contentType: string;
  events: Array<Record<string, unknown>>;
  text: string;
  waitFor(
    predicate: (events: Array<Record<string, unknown>>) => boolean,
    timeoutMs: number,
  ): Promise<Array<Record<string, unknown>>>;
  close(): void;
}

export function rawRequest(
  origin: string,
  rawPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: rawPath,
        method: "GET",
        agent: false,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export function openSse(urlString: string, headers: Record<string, string>): Promise<SseConnection> {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        headers,
      },
      (res: IncomingMessage) => {
        const events: Array<Record<string, unknown>> = [];
        let buffer = "";
        let text = "";
        const waiters: Array<() => boolean> = [];
        const connection: SseConnection = {
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          events,
          get text() {
            return text;
          },
          waitFor(predicate, timeoutMs) {
            if (predicate(events)) {
              return Promise.resolve(events);
            }
            return new Promise((resolveWait, rejectWait) => {
              const timer = setTimeout(() => {
                rejectWait(new Error(`SSE timed out with ${events.length} events`));
              }, timeoutMs);
              waiters.push(() => {
                if (!predicate(events)) {
                  return false;
                }
                clearTimeout(timer);
                resolveWait(events);
                return true;
              });
            });
          },
          close() {
            res.destroy();
            req.destroy();
          },
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (!connection.contentType.includes("text/event-stream")) {
            return;
          }
          buffer += chunk;
          const drained = drainSse(buffer);
          buffer = drained.rest;
          events.push(...drained.events);
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            if (waiters[index]()) {
              waiters.splice(index, 1);
            }
          }
        });
        res.on("error", reject);
        resolve(connection);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function drainSse(buffer: string): { events: Array<Record<string, unknown>>; rest: string } {
  const events: Array<Record<string, unknown>> = [];
  let rest = buffer;
  while (true) {
    const splitAt = rest.indexOf("\n\n");
    if (splitAt < 0) {
      break;
    }
    const block = rest.slice(0, splitAt);
    rest = rest.slice(splitAt + 2);
    if (block.trim().length === 0 || block.startsWith(":")) {
      continue;
    }
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      continue;
    }
    events.push(JSON.parse(data) as Record<string, unknown>);
  }
  return { events, rest };
}
