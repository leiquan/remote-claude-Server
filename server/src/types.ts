/**
 * v0 types for the personal Remote Claude gateway.
 * `simulated` marks mock-adapter behavior. It is never a Claude website session.
 */

export const SERVICE_ID = "remote-claude-gateway";
export const PROTOCOL_VERSION = "0";
export const SIMULATED_MODEL_ID = "sim.echo";
export const SIMULATED_MODEL_NAME = "Simulated echo (not Claude)";

export type AdapterKind = "unconfigured" | "mock" | "browser";

export type CapabilityState = "supported" | "not_configured" | "simulated";

export interface Capabilities {
  protocolDetection: "supported";
  gatewayAuth: "supported" | "not_configured";
  sessionLifecycle: "supported";
  loginStateMachine: "supported";
  eventStream: "supported";
  cancellation: "supported";
  claudeWebsiteLogin: "not_configured" | "simulated";
  liveModelCatalog: "not_configured" | "simulated";
  liveConversation: "not_configured" | "simulated";
}

export type LoginState =
  | "unauthenticated"
  | "authenticating"
  | "verification_required"
  | "authenticated"
  | "expired"
  | "failed";

export type ActionType =
  | "login_input"
  | "login_submit"
  | "select_model"
  | "send_message"
  | "cancel"
  | "browser_navigate"
  | "browser_read"
  | "browser_click"
  | "browser_screenshot";

/** Kinds an iOS client may submit. Password is never one of them. */
export type LoginInputKind = "email_address" | "verification_code";

export type LoginStep = "start" | "challenge" | "verification";

export type SimulationResult = "authenticated" | "failed" | "expired";

export interface LoginView {
  loginId: string;
  state: LoginState;
  allowedActions: ActionType[];
  /** Inputs this session context can accept right now. Empty means do not invent a field. */
  supportedInputs: LoginInputKind[];
  passwordLogin: "unsupported";
  /** True only after the mock adapter has driven this login record. */
  simulated: boolean;
}

export interface ModelDescriptor {
  id: string;
  displayName: string;
  available: boolean;
  simulated: boolean;
}

export interface ConversationView {
  conversationId: string;
  clientRequestId: string;
  modelId: string;
  /** Latest accepted user message, not a model reply. */
  text: string;
}

export interface SessionView {
  sessionId: string;
  serviceId: typeof SERVICE_ID;
  protocolVersion: typeof PROTOCOL_VERSION;
  claudeUsable: false;
  adapter: AdapterKind;
  capabilities: Capabilities;
  login: LoginView;
  models: ModelDescriptor[];
  modelsStatus: "not_configured" | "simulated";
  selectedModelId: string | null;
  conversation: ConversationView | null;
  activeRequestIds: string[];
}

export type ErrorCode =
  | "auth_required"
  | "auth_invalid"
  | "auth_not_configured"
  | "not_found"
  | "session_not_found"
  | "request_not_found"
  | "method_not_allowed"
  | "invalid_json"
  | "invalid_action"
  | "invalid_path"
  | "payload_rejected"
  | "payload_too_large"
  | "action_id_conflict"
  | "request_id_conflict"
  | "client_request_conflict"
  | "invalid_state"
  | "not_configured"
  | "unsupported"
  | "claude_login_required"
  | "model_unavailable"
  | "not_cancellable"
  | "event_cursor_invalid"
  | "login_method_unavailable"
  | "browser_host_disabled"
  | "browser_host_unavailable"
  | "navigation_rejected"
  | "automatic_action_stopped"
  | "login_input_unsupported";

export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: false;
}

export type ActionOutcome = "accepted" | "rejected";

/** Local browser observation. A title or load is not a Claude login. */
export interface BrowserObservation {
  localAck: true;
  siteAck: false;
  claudeLoginVerified: false;
  title: string | null;
  visibleText: string | null;
  screenshotPngBase64: string | null;
  pageStop: "not_attempted" | "attempted";
  upstream: "unknown" | "not_applicable";
}

export interface ActionResultBody {
  actionId: string;
  requestId: string | null;
  status: ActionOutcome | "duplicate";
  originalStatus: ActionOutcome | null;
  originalActionId: string | null;
  error: PublicError | null;
  session: SessionView;
  browser?: BrowserObservation;
}

export interface HealthBody {
  serviceId: typeof SERVICE_ID;
  protocolVersion: typeof PROTOCOL_VERSION;
  /** This milestone never reports Claude as usable, including under the mock adapter. */
  claudeUsable: false;
  adapter: AdapterKind;
  capabilities: Capabilities;
  authentication: {
    controlOperations: "bearer";
    gatewayTokenConfigured: boolean;
    /** Health never authorizes a control call. */
    thisResponseAuthorizesControl: false;
  };
  browserLogin: {
    passwordLogin: "unsupported";
    verified: false;
    automatedAccess: "not_attempted" | "blocked";
    blocker: "cloudflare_challenge" | null;
  };
  browserHost: {
    running: boolean;
    /** This build never navigates the browser to Claude. */
    claudeNavigation: "disabled";
    liveLoginVerified: false;
  };
}

export type StreamEventDraft =
  | {
      type: "delta";
      requestId: string;
      actionId: string;
      simulated: boolean;
      delta: string;
    }
  | {
      type: "completed";
      requestId: string;
      actionId: string;
      simulated: boolean;
    }
  | {
      type: "error";
      requestId: string;
      actionId: string;
      simulated: boolean;
      error: PublicError;
    }
  | {
      type: "auth_required";
      requestId: string;
      actionId: string;
      simulated: boolean;
      error: PublicError;
    }
  | {
      type: "cancelled";
      requestId: string;
      actionId: string | null;
      sourceActionId: string;
      cause: "client_cancel" | "session_deleted" | "subscriber_disconnect";
      simulated: boolean;
      stop: {
        localForwarding: "stopped";
        page: "not_attempted" | "attempted";
        upstream: "not_applicable" | "unknown";
      };
    }
  | {
      type: "login_state";
      requestId: null;
      actionId: string;
      simulated: boolean;
      login: LoginView;
    };

export type StreamEvent = StreamEventDraft & { eventId: string };

export type LoginInputAction = {
  type: "login_input";
  actionId: string;
  step: LoginStep;
  simulationResult?: SimulationResult;
};

export type LoginSubmitAction = {
  type: "login_submit";
  actionId: string;
  kind: LoginInputKind;
  value: string;
};

export type SelectModelAction = {
  type: "select_model";
  actionId: string;
  modelId: string;
};

export type SendMessageAction = {
  type: "send_message";
  actionId: string;
  requestId: string;
  clientRequestId: string;
  modelId: string;
  text: string;
};

export type CancelAction = {
  type: "cancel";
  actionId: string;
  requestId: string;
};

export type BrowserNavigateAction = {
  type: "browser_navigate";
  actionId: string;
  url: string;
};

export type BrowserReadAction = {
  type: "browser_read";
  actionId: string;
};

export type BrowserClickAction = {
  type: "browser_click";
  actionId: string;
  x: number;
  y: number;
};

export type BrowserScreenshotAction = {
  type: "browser_screenshot";
  actionId: string;
};

export type GatewayAction =
  | LoginInputAction
  | LoginSubmitAction
  | SelectModelAction
  | SendMessageAction
  | CancelAction
  | BrowserNavigateAction
  | BrowserReadAction
  | BrowserClickAction
  | BrowserScreenshotAction;

export interface AuditRecord {
  event: string;
  code?: ErrorCode | string;
  httpStatus?: number;
  sessionId?: string;
  actionType?: ActionType | string;
  requestId?: string;
}

export interface Subscriber {
  send: (event: StreamEvent) => void;
  close: () => void;
}
