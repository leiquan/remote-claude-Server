import { CLI_SESSION_ID, runClaudeTurn } from "./claude-cli.ts";
import type { GatewayConfig } from "./config.ts";
import { randomBytes } from "node:crypto";
import { messageFingerprint, parseAction } from "./actions.ts";
import { AutomaticActionStopped, BrowserHost } from "./browser/host.ts";
import { NavigationRejectedError } from "./browser/allowlist.ts";
import {
  LOGIN_METHOD_UNAVAILABLE,
  NOT_CONFIGURED_CONVERSATION,
  NOT_CONFIGURED_LOGIN,
  NOT_CONFIGURED_MODELS,
  publicError,
} from "./errors.ts";
import { containsCredentialKey } from "./json-safety.ts";
import { tokenFingerprint } from "./token.ts";
import type {
  ActionOutcome,
  ActionResultBody,
  ActionType,
  AdapterKind,
  AuditRecord,
  Capabilities,
  ConversationView,
  GatewayAction,
  HealthBody,
  LoginState,
  LoginView,
  PublicError,
  SessionView,
  StreamEvent,
  StreamEventDraft,
  Subscriber,
} from "./types.ts";
import { PROTOCOL_VERSION, SERVICE_ID, SIMULATED_MODEL_ID, SIMULATED_MODEL_NAME } from "./types.ts";

const MAX_SESSIONS = 100;
const MAX_EVENTS = 500;
const MAX_TOMBSTONES = 1000;

type RequestStatus = "streaming" | "completed" | "cancelled" | "rejected";

interface StoredRequest {
  requestId: string;
  clientRequestId: string;
  actionId: string;
  modelId: string;
  text: string;
  messageFingerprint: string;
  status: RequestStatus;
  timer: NodeJS.Timeout | null;
  controller?: AbortController;
}

interface StoredAction {
  fingerprint: string;
  httpStatus: number;
  actionId: string;
  requestId: string | null;
  originalActionId: string | null;
  outcome: ActionOutcome;
  error: PublicError | null;
  browser?: import("./types.ts").BrowserObservation;
}

interface SessionRecord {
  sessionId: string;
  ownerFingerprint: string;
  loginId: string;
  loginState: LoginState;
  loginSimulated: boolean;
  selectedModelId: string | null;
  conversation: ConversationView | null;
  actions: Map<string, StoredAction>;
  requests: Map<string, StoredRequest>;
  requestsByClientId: Map<string, StoredRequest>;
  events: StreamEvent[];
  subscribers: Set<Subscriber>;
  eventCounter: number;
  cliSessionId?: string;
  cliVerified?: boolean;
  cliRun?: Promise<void>;
  history: { role: "user" | "assistant"; text: string }[];
}

export interface GatewayOptions {
  cli?: GatewayConfig["cli"];
  adapter: AdapterKind;
  token: string | null;
  mockSettleMs?: number;
  audit?: (record: AuditRecord) => void;
  browserHostRunning?: boolean;
  browserHost?: BrowserHost | null;
}

export type GatewayResponse =
  | { kind: "empty"; httpStatus: 204 }
  | { kind: "json"; httpStatus: number; body: unknown }
  | {
      kind: "stream";
      replayAndSubscribe: (subscriber: Subscriber) => () => void;
    };

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export class Gateway {
  readonly adapter: AdapterKind;
  readonly token: string | null;
  readonly ownerFingerprint: string | null;
  private readonly mockSettleMs: number;
  private readonly audit: (record: AuditRecord) => void;
  private readonly browserHostRunning: boolean;
  private readonly browserHost: BrowserHost | null;
  private readonly cli: GatewayConfig["cli"];
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tombstones = new Set<string>();

  constructor(options: GatewayOptions) {
    this.adapter = options.adapter;
    this.cli = options.adapter === "cli" ? options.cli : undefined;
    this.token = options.token;
    this.ownerFingerprint = options.token ? tokenFingerprint(options.token) : null;
    this.mockSettleMs = options.mockSettleMs ?? 400;
    this.audit = options.audit ?? (() => undefined);
    this.browserHost = options.browserHost ?? null;
    this.browserHostRunning = options.browserHostRunning ?? this.browserHost !== null;
  }

  health(): HealthBody {
    return {
      serviceId: SERVICE_ID,
      protocolVersion: PROTOCOL_VERSION,
      claudeUsable: false,
      adapter: this.adapter,
      capabilities: this.capabilities(),
      authentication: {
        controlOperations: "bearer",
        gatewayTokenConfigured: this.token !== null,
        thisResponseAuthorizesControl: false,
      },
      browserLogin: {
        passwordLogin: "unsupported",
        verified: false,
        automatedAccess: this.adapter === "browser" ? "blocked" : "not_attempted",
        blocker: this.adapter === "browser" ? "cloudflare_challenge" : null,
      },
      browserHost: {
        running: this.browserHostRunning,
        claudeNavigation: "disabled",
        liveLoginVerified: false,
      },
    };
  }

  async createSession(): Promise<GatewayResponse> {
    if (this.sessions.size >= MAX_SESSIONS) {
      return this.failure(503, publicError("unsupported", "The gateway session limit was reached."));
    }
    const session = this.blankSession();
    if (this.adapter === "browser" && this.browserHost) {
      try {
        await this.browserHost.openSession(session.sessionId);
      } catch {
        return this.failure(503, publicError("browser_host_unavailable"));
      }
    }
    this.sessions.set(session.sessionId, session);
    this.audit({ event: "session_created", sessionId: session.sessionId, httpStatus: 201 });
    return { kind: "json", httpStatus: 201, body: { session: this.view(session) } };
  }

  listSessions(): GatewayResponse {
    const sessions = [...this.sessions.values()].filter(session => this.ownedSession(session.sessionId)).reverse();
    return {
      kind: "json", httpStatus: 200,
      body: { sessions: sessions.map(session => ({
        sessionId: session.sessionId,
        title: session.history.find(message => message.role === "user")?.text.slice(0, 60) ?? null,
      })) },
    };
  }

  getSession(sessionId: string): GatewayResponse {
    const session = this.ownedSession(sessionId);
    if (!session) {
      return this.failure(404, publicError("session_not_found"));
    }
    return { kind: "json", httpStatus: 200, body: { session: this.view(session), ...(this.cli ? { history: session.history } : {}) } };
  }

  async deleteSession(sessionId: string): Promise<GatewayResponse> {
    if (this.tombstones.has(sessionId)) {
      return { kind: "empty", httpStatus: 204 };
    }
    const session = this.ownedSession(sessionId);
    if (!session) {
      return this.failure(404, publicError("session_not_found"));
    }
    for (const request of session.requests.values()) {
      if (request.status === "streaming") {
        this.finishRequest(session, request, {
          type: "cancelled",
          requestId: request.requestId,
          actionId: null,
          sourceActionId: request.actionId,
          cause: "session_deleted",
          simulated: this.adapter === "mock",
          stop: this.stopReport(this.browserHost ? "attempted" : "not_attempted"),
        });
      }
    }
    for (const subscriber of [...session.subscribers]) {
      session.subscribers.delete(subscriber);
      try {
        subscriber.close();
      } catch {
        // The stream is already gone; deletion still succeeds.
      }
    }
    this.sessions.delete(sessionId);
    this.rememberTombstone(sessionId);
    await session.cliRun;
    if (this.browserHost) {
      await this.browserHost.closeSession(sessionId);
    }
    this.audit({ event: "session_deleted", sessionId, httpStatus: 204 });
    return { kind: "empty", httpStatus: 204 };
  }

  openEvents(sessionId: string, lastEventId: string | undefined): GatewayResponse {
    const session = this.ownedSession(sessionId);
    if (!session) {
      return this.failure(404, publicError("session_not_found"));
    }
    let start = 0;
    if (lastEventId !== undefined && lastEventId !== "") {
      const index = session.events.findIndex((event) => event.eventId === lastEventId);
      if (index < 0) {
        this.audit({
          event: "event_cursor_invalid",
          code: "event_cursor_invalid",
          sessionId,
          httpStatus: 409,
        });
        return this.failure(409, publicError("event_cursor_invalid"));
      }
      start = index + 1;
    }
    const replay = session.events.slice(start);
    return {
      kind: "stream",
      replayAndSubscribe: (subscriber) => {
        for (const event of replay) {
          subscriber.send(event);
        }
        session.subscribers.add(subscriber);
        return () => {
          this.releaseSubscriber(session, subscriber);
        };
      },
    };
  }

  async performAction(sessionId: string, payload: unknown): Promise<GatewayResponse> {
    const session = this.ownedSession(sessionId);
    if (!session) {
      return this.failure(404, publicError("session_not_found"));
    }
    if (containsCredentialKey(payload)) {
      this.audit({
        event: "payload_rejected",
        code: "payload_rejected",
        httpStatus: 400,
        sessionId,
      });
      return this.failure(400, publicError("payload_rejected"));
    }
    const parsed = parseAction(payload);
    if (!parsed.ok) {
      this.audit({
        event: "i…3819 tokens truncated…rememberTerminalRequest(session, action, "rejected");
      this.emit(session, {
        type: "error",
        requestId: action.requestId,
        actionId: action.actionId,
        simulated: this.adapter === "mock",
        error,
      });
      return this.rejectAction(session, fingerprint, 409, action.actionId, action.requestId, error, "send_message");
    }
    const request = this.rememberTerminalRequest(session, action, "streaming");
    if (!session.conversation) {
      session.conversation = {
        conversationId: newId("cnv"),
        clientRequestId: action.clientRequestId,
        modelId: action.modelId,
        text: action.text,
      };
    } else {
      session.conversation = {
        ...session.conversation,
        clientRequestId: action.clientRequestId,
        modelId: action.modelId,
        text: action.text,
      };
    }
    if (this.cli) {
      const run = this.generateWithCli(session, request, this.cli);
      session.cliRun = run;
      void run.finally(() => { session.cliRun = undefined; });
    } else {
      this.generateMock(session, request);
    }
    this.audit({
      event: "message_accepted",
      sessionId: session.sessionId,
      actionType: "send_message",
      requestId: action.requestId,
      httpStatus: 202,
    });
    const stored = this.storeAction(session, fingerprint, 202, {
      actionId: action.actionId,
      requestId: action.requestId,
      originalActionId: null,
      outcome: "accepted",
      error: null,
    });
    return this.firstResult(session, stored);
  }

  private generateMock(session: SessionRecord, request: StoredRequest): void {
    const pieces = splitEcho(request.text);
    for (const delta of pieces) {
      this.emit(session, {
        type: "delta",
        requestId: request.requestId,
        actionId: request.actionId,
        simulated: true,
        delta,
      });
    }
    request.timer = setTimeout(() => {
      this.finishRequest(session, request, {
        type: "completed",
        requestId: request.requestId,
        actionId: request.actionId,
        simulated: true,
      });
    }, this.mockSettleMs);
  }

  private async generateWithCli(
    session: SessionRecord,
    request: StoredRequest,
    cli: NonNullable<GatewayOptions["cli"]>,
  ): Promise<void> {
    const controller = new AbortController();
    request.controller = controller;
    const ids = { requestId: request.requestId, actionId: request.actionId, simulated: false };
    try {
      const result = await runClaudeTurn(request.text, {
        cwd: cli.cwd,
        executable: cli.executable,
        model: request.modelId,
        resumeSessionId: session.cliSessionId,
        signal: controller.signal,
        onDelta: delta => {
          if (request.status === "streaming") this.emit(session, { type: "delta", delta, ...ids });
        },
      });
      if (request.status !== "streaming" || controller.signal.aborted) return;
      if (!result.sessionId || !CLI_SESSION_ID.test(result.sessionId)) throw new Error("Invalid CLI session");
      session.cliSessionId = result.sessionId;
      session.cliVerified = true;
      session.history.push({ role: "user", text: request.text }, { role: "assistant", text: result.text.slice(0, 65_536) });
      if (session.history.length > 40) session.history.splice(0, 2);
      this.finishRequest(session, request, { type: "completed", ...ids });
    } catch {
      if (request.status !== "streaming" || controller.signal.aborted) return;
      request.status = "rejected";
      this.emit(session, { type: "error", error: publicError("cli_failed"), ...ids });
    } finally {
      request.controller = undefined;
    }
  }

  private executeCancel(
    session: SessionRecord,
    action: Extract<GatewayAction, { type: "cancel" }>,
    fingerprint: string,
  ): GatewayResponse {
    const request = session.requests.get(action.requestId);
    if (!request) {
      return this.rejectAction(
        session,
        fingerprint,
        404,
        action.actionId,
        action.requestId,
        publicError("request_not_found"),
        "cancel",
      );
    }
    if (request.status !== "streaming") {
      return this.rejectAction(
        session,
        fingerprint,
        409,
        action.actionId,
        action.requestId,
        publicError("not_cancellable"),
        "cancel",
      );
    }
    this.finishRequest(session, request, {
      type: "cancelled",
      requestId: request.requestId,
      actionId: action.actionId,
      sourceActionId: request.actionId,
      cause: "client_cancel",
      simulated: this.adapter === "mock",
      stop: this.stopReport("not_attempted"),
    });
    this.audit({
      event: "request_cancelled",
      sessionId: session.sessionId,
      actionType: "cancel",
      requestId: action.requestId,
      httpStatus: 200,
    });
    const stored = this.storeAction(session, fingerprint, 200, {
      actionId: action.actionId,
      requestId: action.requestId,
      originalActionId: null,
      outcome: "accepted",
      error: null,
    });
    return this.firstResult(session, stored);
  }

  private rejectAction(
    session: SessionRecord,
    fingerprint: string,
    httpStatus: number,
    actionId: string,
    requestId: string | null,
    error: PublicError,
    actionType: ActionType,
  ): GatewayResponse {
    this.storeAction(session, fingerprint, httpStatus, {
      actionId,
      requestId,
      originalActionId: null,
      outcome: "rejected",
      error,
    });
    this.audit({
      event: "action_rejected",
      code: error.code,
      httpStatus,
      sessionId: session.sessionId,
      actionType,
      ...(requestId ? { requestId } : {}),
    });
    return this.actionResponse(session, httpStatus, {
      actionId,
      requestId,
      originalActionId: null,
      outcome: "rejected",
      error,
    }, false);
  }

  private rememberTerminalRequest(
    session: SessionRecord,
    action: Extract<GatewayAction, { type: "send_message" }>,
    status: RequestStatus,
  ): StoredRequest {
    const request: StoredRequest = {
      requestId: action.requestId,
      clientRequestId: action.clientRequestId,
      actionId: action.actionId,
      modelId: action.modelId,
      text: action.text,
      messageFingerprint: messageFingerprint(action.modelId, action.text),
      status,
      timer: null,
    };
    session.requests.set(request.requestId, request);
    session.requestsByClientId.set(request.clientRequestId, request);
    return request;
  }

  /**
   * A real event-stream connection closed. The POST that started a generation
   * also completes its request body; that completion must not call this.
   * Only the last remaining subscriber releases active generations.
   */
  private releaseSubscriber(session: SessionRecord, subscriber: Subscriber): void {
    if (!session.subscribers.delete(subscriber)) {
      return;
    }
    if (session.subscribers.size > 0) {
      return;
    }
    for (const request of [...session.requests.values()]) {
      if (request.status !== "streaming") {
        continue;
      }
      this.finishRequest(session, request, {
        type: "cancelled",
        requestId: request.requestId,
        actionId: null,
        sourceActionId: request.actionId,
        cause: "subscriber_disconnect",
        simulated: this.adapter === "mock",
        stop: this.stopReport("not_attempted"),
      });
    }
  }

  private finishRequest(
    session: SessionRecord,
    request: StoredRequest,
    event: Extract<StreamEventDraft, { type: "completed" | "cancelled" }>,
  ): void {
    if (request.status !== "streaming") {
      return;
    }
    if (request.timer) {
      clearTimeout(request.timer);
      request.timer = null;
    }
    request.status = event.type === "completed" ? "completed" : "cancelled";
    if (event.type === "cancelled") request.controller?.abort();
    this.emit(session, event);
  }

  private emit(session: SessionRecord, event: StreamEventDraft): void {
    const stored = { ...event, eventId: this.nextEventId(session) } as StreamEvent;
    session.events.push(stored);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    for (const subscriber of [...session.subscribers]) {
      try {
        subscriber.send(stored);
      } catch {
        session.subscribers.delete(subscriber);
      }
    }
  }

  private nextEventId(session: SessionRecord): string {
    session.eventCounter += 1;
    return `evt_${session.eventCounter.toString(16)}_${randomBytes(4).toString("hex")}`;
  }

  private storeAction(
    session: SessionRecord,
    fingerprint: string,
    httpStatus: number,
    fields: Omit<StoredAction, "fingerprint" | "httpStatus">,
  ): StoredAction {
    const stored: StoredAction = { fingerprint, httpStatus, ...fields };
    session.actions.set(fields.actionId, stored);
    return stored;
  }

  private replay(session: SessionRecord, stored: StoredAction): GatewayResponse {
    this.audit({
      event: "action_duplicate",
      sessionId: session.sessionId,
      httpStatus: stored.httpStatus,
      ...(stored.requestId ? { requestId: stored.requestId } : {}),
    });
    return this.actionResponse(session, stored.httpStatus, stored, true);
  }

  private firstResult(session: SessionRecord, stored: StoredAction): GatewayResponse {
    return this.actionResponse(session, stored.httpStatus, stored, false);
  }

  private actionResponse(
    session: SessionRecord,
    httpStatus: number,
    stored: Omit<StoredAction, "fingerprint" | "httpStatus">,
    duplicate: boolean,
  ): GatewayResponse {
    const body: ActionResultBody = {
      actionId: stored.actionId,
      requestId: stored.requestId,
      status: duplicate ? "duplicate" : stored.outcome,
      originalStatus: duplicate ? stored.outcome : null,
      originalActionId: duplicate ? (stored.originalActionId ?? stored.actionId) : stored.originalActionId,
      error: stored.error,
      session: this.view(session),
      ...(stored.browser ? { browser: stored.browser } : {}),
    };
    return { kind: "json", httpStatus, body };
  }

  private blankSession(): SessionRecord {
    return {
      sessionId: newId("ses"),
      ownerFingerprint: this.ownerFingerprint ?? "",
      loginId: newId("log"),
      loginState: "unauthenticated",
      loginSimulated: false,
      selectedModelId: null,
      conversation: null,
      actions: new Map(),
      requests: new Map(),
      requestsByClientId: new Map(),
      events: [],
      subscribers: new Set(),
      eventCounter: 0,
      history: [],
    };
  }

  private ownedSession(sessionId: string): SessionRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (!this.ownerFingerprint || session.ownerFingerprint !== this.ownerFingerprint) {
      return null;
    }
    return session;
  }

  private rememberTombstone(sessionId: string): void {
    this.tombstones.add(sessionId);
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.values().next().value;
      if (oldest) {
        this.tombstones.delete(oldest);
      }
    }
  }

  private capabilities(): Capabilities {
    const simulated = this.adapter === "mock";
    return {
      protocolDetection: "supported",
      gatewayAuth: this.token ? "supported" : "not_configured",
      sessionLifecycle: "supported",
      loginStateMachine: "supported",
      eventStream: "supported",
      cancellation: "supported",
      claudeWebsiteLogin: simulated ? "simulated" : "not_configured",
      liveModelCatalog: simulated ? "simulated" : this.cli ? "supported" : "not_configured",
      liveConversation: simulated ? "simulated" : this.cli ? "supported" : "not_configured",
    };
  }

  private loginView(session: SessionRecord): LoginView {
    return {
      loginId: session.loginId,
      state: session.loginState,
      allowedActions: this.allowedActions(session),
      simulated: session.loginSimulated,
    };
  }

  private allowedActions(session: SessionRecord): ActionType[] {
    const actions: ActionType[] = [];
    if (this.cli) actions.push("select_model", "send_message");
    if (this.adapter === "browser" && this.browserHost) {
      actions.push("browser_navigate", "browser_read", "browser_click", "browser_screenshot");
    }
    if (this.adapter === "mock") {
      if (
        session.loginState === "unauthenticated" ||
        session.loginState === "authenticating" ||
        session.loginState === "verification_required" ||
        session.loginState === "failed" ||
        session.loginState === "expired"
      ) {
        actions.push("login_input");
      }
      if (session.loginState === "authenticated") {
        actions.push("select_model", "send_message");
      }
    }
    for (const request of session.requests.values()) {
      if (request.status === "streaming") {
        actions.push("cancel");
        break;
      }
    }
    return actions;
  }

  private view(session: SessionRecord): SessionView {
    const simulated = this.adapter === "mock";
    const available = simulated && session.loginState === "authenticated";
    const activeRequestIds = [...session.requests.values()]
      .filter((request) => request.status === "streaming")
      .map((request) => request.requestId);
    return {
      sessionId: session.sessionId,
      serviceId: SERVICE_ID,
      protocolVersion: PROTOCOL_VERSION,
      claudeUsable: session.cliVerified === true,
      adapter: this.adapter,
      capabilities: this.capabilities(),
      login: this.loginView(session),
      models: this.cli ? this.cli.models.map(id => ({ id, displayName: id, available: true, simulated: false })) : simulated
        ? [
            {
              id: SIMULATED_MODEL_ID,
              displayName: SIMULATED_MODEL_NAME,
              available,
              simulated: true,
            },
          ]
        : [],
      modelsStatus: simulated ? "simulated" : this.cli ? "supported" : "not_configured",
      selectedModelId: session.selectedModelId,
      conversation: session.conversation,
      activeRequestIds,
    };
  }

  private failure(httpStatus: number, error: PublicError): GatewayResponse {
    return { kind: "json", httpStatus, body: { error } };
  }
}

function splitEcho(text: string): string[] {
  if (text.length <= 1) {
    return [text];
  }
  const mid = Math.ceil(text.length / 2);
  return [text.slice(0, mid), text.slice(mid)];
}
