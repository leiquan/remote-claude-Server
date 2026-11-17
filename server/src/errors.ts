import type { ErrorCode, PublicError } from "./types.ts";

const MESSAGES: Record<ErrorCode, string> = {
  auth_required: "Gateway access token is required.",
  auth_invalid: "Gateway access token is invalid.",
  auth_not_configured: "Gateway access token is not configured.",
  not_found: "No such gateway route.",
  session_not_found: "Session was not found.",
  request_not_found: "Request was not found.",
  method_not_allowed: "Method is not allowed for this route.",
  invalid_json: "Request body is not valid JSON.",
  invalid_action: "Action payload does not match the v0 contract.",
  invalid_path: "The request path is not a normalized gateway path.",
  payload_rejected: "Credential material is not accepted by this gateway.",
  payload_too_large: "Request body exceeds the size limit.",
  action_id_conflict: "actionId was reused with a different payload.",
  request_id_conflict: "requestId was reused with a different payload.",
  client_request_conflict: "clientRequestId was reused with a different message.",
  invalid_state: "Action is not allowed in the current login state.",
  not_configured: "Live Claude functionality is not configured on this gateway.",
  unsupported: "The gateway could not complete the operation.",
  claude_login_required: "The simulated session is not authenticated.",
  model_unavailable: "The requested model is not available.",
  not_cancellable: "The request can no longer be cancelled.",
  login_method_unavailable:
    "Claude has no dedicated account password. Google sign-in or an email link must be completed by the operator on this host. Automated browser login is blocked and has not been verified.",
  browser_host_disabled: "The local browser host is not running. No page was opened.",
  browser_host_unavailable: "The local browser host could not open a session. No fallback was used.",
  navigation_rejected: "Browser navigation target was rejected. No fallback was used.",
  automatic_action_stopped: "Automatic browser action stopped. No fallback was used.",
  event_cursor_invalid: "Last-Event-ID does not match a retained event. Resync is required. The gateway will not resume a send.",
};

const HTTP_STATUS: Record<ErrorCode, number> = {
  auth_required: 401,
  auth_invalid: 401,
  auth_not_configured: 503,
  not_found: 404,
  session_not_found: 404,
  request_not_found: 404,
  method_not_allowed: 405,
  invalid_json: 400,
  invalid_action: 400,
  invalid_path: 400,
  payload_rejected: 400,
  payload_too_large: 413,
  action_id_conflict: 409,
  request_id_conflict: 409,
  client_request_conflict: 409,
  invalid_state: 409,
  not_configured: 501,
  unsupported: 501,
  claude_login_required: 409,
  model_unavailable: 409,
  not_cancellable: 409,
  event_cursor_invalid: 409,
  login_method_unavailable: 501,
  browser_host_disabled: 503,
  browser_host_unavailable: 503,
  navigation_rejected: 409,
  automatic_action_stopped: 409,
};

export function publicError(code: ErrorCode, message?: string): PublicError {
  return {
    code,
    message: message ?? MESSAGES[code],
    retryable: false,
  };
}

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export const LOGIN_METHOD_UNAVAILABLE = publicError("login_method_unavailable");

export const NOT_CONFIGURED_LOGIN = publicError(
  "not_configured",
  "Claude website login is not configured. The browser-login adapter is unimplemented.",
);

export const NOT_CONFIGURED_MODELS = publicError(
  "not_configured",
  "Live model catalog is not configured.",
);

export const NOT_CONFIGURED_CONVERSATION = publicError(
  "not_configured",
  "Live conversation is not configured.",
);
