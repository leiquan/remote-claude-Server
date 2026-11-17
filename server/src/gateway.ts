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
}

export interface GatewayOptions {
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
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly tombstones = new Set<string>();

  constructor(options: GatewayOptions) {
    this.adapter = options.adapter;
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

  getSession(sessionId: string): GatewayResponse {
    const session = this.ownedSession(sessionId);
    if (!session) {
      return this.failure(404, publicError("session_not_found"));
    }
    return { kind: "json", httpStatus: 200, body: { session: this.view(session) } };
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
        event: "invalid_action",
        code: "invalid_action",
        httpStatus: 400,
        sessionId,
      });
      return this.failure(400, publicError("invalid_action"));
    }
    const prior = session.actions.get(parsed.action.actionId);
    if (prior) {
      if (prior.fingerprint !== parsed.fingerprint) {
        this.audit({
          event: "action_id_conflict",
          code: "action_id_conflict",
          httpStatus: 409,
          sessionId,
          actionType: parsed.action.type,
        });
        return this.actionResponse(session, 409, {
          actionId: parsed.action.actionId,
          requestId: "requestId" in parsed.action ? parsed.action.requestId : null,
          originalActionId: prior.actionId,
          outcome: "rejected",
          error: publicError("action_id_conflict"),
        }, false);
      }
      return this.replay(session, prior);
    }
    if (parsed.action.type === "send_message") {
      const existing = session.requestsByClientId.get(parsed.action.clientRequestId);
      if (existing) {
        if (existing.messageFingerprint !== messageFingerprint(parsed.action.modelId, parsed.action.text)) {
          const error = publicError("client_request_conflict");
          this.storeAction(session, parsed.fingerprint, 409, {
            actionId: parsed.action.actionId,
            requestId: existing.requestId,
            originalActionId: existing.actionId,
            outcome: "rejected",
            error,
          });
          this.audit({
            event: "client_request_conflict",
            code: "client_request_conflict",
            httpStatus: 409,
            sessionId,
            actionType: "send_message",
            requestId: existing.requestId,
          });
          return this.actionResponse(
            session,
            409,
            {
              actionId: parsed.action.actionId,
              requestId: existing.requestId,
              originalActionId: existing.actionId,
              outcome: "rejected",
              error,
            },
            false,
          );
        }
        const original = session.actions.get(existing.actionId);
        const stored = this.storeAction(session, parsed.fingerprint, original?.httpStatus ?? 202, {
          actionId: parsed.action.actionId,
          requestId: existing.requestId,
          originalActionId: existing.actionId,
          outcome: original?.outcome ?? "accepted",
          error: original?.error ?? null,
        });
        return this.replay(session, stored);
      }
      if (session.requests.has(parsed.action.requestId)) {
        const error = publicError("request_id_conflict");
        this.storeAction(session, parsed.fingerprint, 409, {
          actionId: parsed.action.actionId,
          requestId: parsed.action.requestId,
          originalActionId: null,
          outcome: "rejected",
          error,
        });
        this.audit({
          event: "request_id_conflict",
          code: "request_id_conflict",
          httpStatus: 409,
          sessionId,
          actionType: "send_message",
          requestId: parsed.action.requestId,
        });
        return this.actionResponse(
          session,
          409,
          {
            actionId: parsed.action.actionId,
            requestId: parsed.action.requestId,
            originalActionId: null,
            outcome: "rejected",
            error,
          },
          false,
        );
      }
    }
    return this.execute(session, parsed.action, parsed.fingerprint);
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const request of session.requests.values()) {
        if (request.timer) {
          clearTimeout(request.timer);
          request.timer = null;
        }
      }
      session.subscribers.clear();
    }
    await this.browserHost?.shutdown();
  }

  private execute(session: SessionRecord, action: GatewayAction, fingerprint: string): GatewayResponse | Promise<GatewayResponse> {
    if (
      action.type === "browser_navigate" ||
      action.type === "browser_read" ||
      action.type === "browser_click" ||
      action.type === "browser_screenshot"
    ) {
      return this.executeBrowser(session, action, fingerprint);
    }
    if (action.type === "login_input") {
      return this.executeLogin(session, action, fingerprint);
    }
    if (action.type === "select_model") {
      return this.executeSelectModel(session, action, fingerprint);
    }
    if (action.type === "send_message") {
      return this.executeSend(session, action, fingerprint);
    }
    return this.executeCancel(session, action, fingerprint);
  }

  private stopReport(page: "not_attempted" | "attempted"): {
    localForwarding: "stopped";
    page: "not_attempted" | "attempted";
    upstream: "not_applicable" | "unknown";
  } {
    return {
      localForwarding: "stopped",
      page,
      upstream: this.adapter === "mock" ? "not_applicable" : "unknown",
    };
  }

  private async executeBrowser(
    session: SessionRecord,
    action: Extract<
      GatewayAction,
      { type: "browser_navigate" | "browser_read" | "browser_click" | "browser_screenshot" }
    >,
    fingerprint: string,
  ): Promise<GatewayResponse> {
    if (this.adapter !== "browser") {
      return this.rejectAction(
        session,
        fingerprint,
        501,
        action.actionId,
        null,
        publicError("unsupported", "Browser control is not available on this adapter."),
        action.type,
      );
    }
    if (!this.browserHost) {
      return this.rejectAction(session, fingerprint, 503, action.actionId, null, publicError("browser_host_disabled"), action.type);
    }
    try {
      let title: string | null = null;
      let visibleText: string | null = null;
      let screenshotPngBase64: string | null = null;
      if (action.type === "browser_navigate") {
        const viewed = await this.browserHost.navigate(session.sessionId, action.url);
        title = viewed.title;
        visibleText = viewed.visibleText;
      } else if (action.type === "browser_click") {
        await this.browserHost.click(session.sessionId, action.x, action.y);
        const viewed = await this.browserHost.read(session.sessionId);
        title = viewed.title;
        visibleText = viewed.visibleText;
      } else if (action.type === "browser_read") {
        const viewed = await this.browserHost.read(session.sessionId);
        title = viewed.title;
        visibleText = viewed.visibleText;
      } else {
        screenshotPngBase64 = await this.browserHost.screenshot(session.sessionId);
      }
      if (!this.ownedSession(session.sessionId)) {
        return this.failure(404, publicError("session_not_found"));
      }
      return this.storeBrowserResult(session, fingerprint, action.actionId, action.type, {
        localAck: true,
        siteAck: false,
        claudeLoginVerified: false,
        title,
        visibleText,
        screenshotPngBase64,
        pageStop: "not_attempted",
        upstream: "not_applicable",
      }, null, 200);
    } catch (error) {
      if (!this.ownedSession(session.sessionId)) {
        return this.failure(404, publicError("session_not_found"));
      }
      if (error instanceof NavigationRejectedError) {
        return this.storeBrowserResult(
          session,
          fingerprint,
          action.actionId,
          action.type,
          {
            localAck: true,
            siteAck: false,
            claudeLoginVerified: false,
            title: null,
            visibleText: null,
            screenshotPngBase64: null,
            pageStop: error.pageStop,
            upstream: "unknown",
          },
          publicError("navigation_rejected"),
          409,
        );
      }
      if (error instanceof AutomaticActionStopped) {
        return this.storeBrowserResult(
          session,
          fingerprint,
          action.actionId,
          action.type,
          {
            localAck: true,
            siteAck: false,
            claudeLoginVerified: false,
            title: null,
            visibleText: null,
            screenshotPngBase64: null,
            pageStop: "attempted",
            upstream: "unknown",
          },
          publicError("automatic_action_stopped"),
          409,
        );
      }
      return this.rejectAction(
        session,
        fingerprint,
        503,
        action.actionId,
        null,
        publicError("browser_host_unavailable"),
        action.type,
      );
    }
  }

  private storeBrowserResult(
    session: SessionRecord,
    fingerprint: string,
    actionId: string,
    actionType: ActionType,
    browser: import("./types.ts").BrowserObservation,
    error: PublicError | null,
    httpStatus: number,
  ): GatewayResponse {
    const stored = this.storeAction(session, fingerprint, httpStatus, {
      actionId,
      requestId: null,
      originalActionId: null,
      outcome: error ? "rejected" : "accepted",
      error,
      browser,
    });
    this.audit({
      event: error ? "browser_action_rejected" : "browser_action_accepted",
      ...(error ? { code: error.code } : {}),
      httpStatus,
      sessionId: session.sessionId,
      actionType,
    });
    return this.firstResult(session, stored);
  }

  private executeLogin(
    session: SessionRecord,
    action: Extract<GatewayAction, { type: "login_input" }>,
    fingerprint: string,
  ): GatewayResponse {
    if (this.adapter === "browser") {
      return this.rejectAction(
        session,
        fingerprint,
        501,
        action.actionId,
        null,
        LOGIN_METHOD_UNAVAILABLE,
        "login_input",
      );
    }
    if (this.adapter !== "mock") {
      return this.rejectAction(session, fingerprint, 501, action.actionId, null, NOT_CONFIGURED_LOGIN, "login_input");
    }
    const state = session.loginState;
    let next: LoginState | null = null;
    if (action.step === "start" && (state === "unauthenticated" || state === "failed" || state === "expired")) {
      next = "authenticating";
    } else if (action.step === "challenge" && state === "authenticating") {
      next = "verification_required";
    } else if (action.step === "verification" && state === "verification_required" && action.simulationResult) {
      next = action.simulationResult;
    }
    if (!next) {
      return this.rejectAction(
        session,
        fingerprint,
        409,
        action.actionId,
        null,
        publicError("invalid_state"),
        "login_input",
      );
    }
    session.loginState = next;
    session.loginSimulated = true;
    if (next !== "authenticated") {
      session.selectedModelId = null;
    }
    const login = this.loginView(session);
    this.emit(session, {
      type: "login_state",
      requestId: null,
      actionId: action.actionId,
      simulated: true,
      login,
    });
    this.audit({
      event: "login_state",
      sessionId: session.sessionId,
      actionType: "login_input",
      httpStatus: 200,
    });
    const stored = this.storeAction(session, fingerprint, 200, {
      actionId: action.actionId,
      requestId: null,
      originalActionId: null,
      outcome: "accepted",
      error: null,
    });
    return this.firstResult(session, stored);
  }

  private executeSelectModel(
    session: SessionRecord,
    action: Extract<GatewayAction, { type: "select_model" }>,
    fingerprint: string,
  ): GatewayResponse {
    if (this.adapter !== "mock") {
      return this.rejectAction(session, fingerprint, 501, action.actionId, null, NOT_CONFIGURED_MODELS, "select_model");
    }
    if (session.loginState !== "authenticated") {
      return this.rejectAction(
        session,
        fingerprint,
        409,
        action.actionId,
        null,
        publicError("claude_login_required"),
        "select_model",
      );
    }
    if (action.modelId !== SIMULATED_MODEL_ID) {
      return this.rejectAction(
        session,
        fingerprint,
        409,
        action.actionId,
        null,
        publicError("model_unavailable"),
        "select_model",
      );
    }
    session.selectedModelId = action.modelId;
    this.audit({
      event: "model_selected",
      sessionId: session.sessionId,
      actionType: "select_model",
      httpStatus: 200,
    });
    const stored = this.storeAction(session, fingerprint, 200, {
      actionId: action.actionId,
      requestId: null,
      originalActionId: null,
      outcome: "accepted",
      error: null,
    });
    return this.firstResult(session, stored);
  }

  private executeSend(
    session: SessionRecord,
    action: Extract<GatewayAction, { type: "send_message" }>,
    fingerprint: string,
  ): GatewayResponse {
    if (this.adapter !== "mock") {
      this.rememberTerminalRequest(session, action, "rejected");
      this.emit(session, {
        type: "error",
        requestId: action.requestId,
        actionId: action.actionId,
        simulated: false,
        error: NOT_CONFIGURED_CONVERSATION,
      });
      return this.rejectAction(
        session,
        fingerprint,
        501,
        action.actionId,
        action.requestId,
        NOT_CONFIGURED_CONVERSATION,
        "send_message",
      );
    }
    if (session.loginState !== "authenticated") {
      const error = publicError("claude_login_required");
      this.rememberTerminalRequest(session, action, "rejected");
      this.emit(session, {
        type: "auth_required",
        requestId: action.requestId,
        actionId: action.actionId,
        simulated: true,
        error,
      });
      return this.rejectAction(session, fingerprint, 409, action.actionId, action.requestId, error, "send_message");
    }
    if (session.selectedModelId !== action.modelId || action.modelId !== SIMULATED_MODEL_ID) {
      const error = publicError(
        session.selectedModelId == null ? "invalid_state" : "model_unavailable",
        session.selectedModelId == null
          ? "Select a model before sending."
          : undefined,
      );
      this.rememberTerminalRequest(session, action, "rejected");
      this.emit(session, {
        type: "error",
        requestId: action.requestId,
        actionId: action.actionId,
        simulated: true,
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
    const pieces = splitEcho(action.text);
    for (const delta of pieces) {
      this.emit(session, {
        type: "delta",
        requestId: action.requestId,
        actionId: action.actionId,
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
      liveModelCatalog: simulated ? "simulated" : "not_configured",
      liveConversation: simulated ? "simulated" : "not_configured",
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
      claudeUsable: false,
      adapter: this.adapter,
      capabilities: this.capabilities(),
      login: this.loginView(session),
      models: simulated
        ? [
            {
              id: SIMULATED_MODEL_ID,
              displayName: SIMULATED_MODEL_NAME,
              available,
              simulated: true,
            },
          ]
        : [],
      modelsStatus: simulated ? "simulated" : "not_configured",
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
