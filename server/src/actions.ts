import { createHash } from "node:crypto";
import type {
  BrowserClickAction,
  BrowserNavigateAction,
  BrowserReadAction,
  BrowserScreenshotAction,
  CancelAction,
  GatewayAction,
  LoginInputAction,
  LoginInputKind,
  LoginSubmitAction,
  SelectModelAction,
  SendMessageAction,
  SimulationResult,
} from "./types.ts";
import { canonicalJson, isClientId, isModelId, isPlainObject, ownKeys } from "./json-safety.ts";

export type ParseResult =
  | { ok: true; action: GatewayAction; fingerprint: string }
  | { ok: false };

const LOGIN_STEPS = new Set(["start", "challenge", "verification"]);
const LOGIN_INPUT_KINDS = new Set<LoginInputKind>(["email_address", "verification_code"]);
const SIMULATION_RESULTS = new Set<SimulationResult>(["authenticated", "failed", "expired"]);

function unexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return ownKeys(value).some((key) => !allow.has(key) || key === "__proto__" || key === "constructor" || key === "prototype");
}

function fingerprintOf(action: GatewayAction): string {
  return createHash("sha256").update(canonicalJson(action)).digest("hex");
}

export function messageFingerprint(modelId: string, text: string): string {
  return createHash("sha256").update(canonicalJson({ modelId, text })).digest("hex");
}

export function parseAction(value: unknown): ParseResult {
  if (!isPlainObject(value)) {
    return { ok: false };
  }
  const type = value.type;
  if (type === "login_input") {
    if (unexpectedKeys(value, ["type", "actionId", "step", "simulationResult"])) {
      return { ok: false };
    }
    if (!isClientId(value.actionId) || typeof value.step !== "string" || !LOGIN_STEPS.has(value.step)) {
      return { ok: false };
    }
    const action: LoginInputAction = {
      type: "login_input",
      actionId: value.actionId,
      step: value.step as LoginInputAction["step"],
    };
    if (value.step === "verification") {
      if (typeof value.simulationResult !== "string" || !SIMULATION_RESULTS.has(value.simulationResult as SimulationResult)) {
        return { ok: false };
      }
      action.simulationResult = value.simulationResult as SimulationResult;
    } else if (Object.prototype.hasOwnProperty.call(value, "simulationResult")) {
      return { ok: false };
    }
    return { ok: true, action, fingerprint: fingerprintOf(action) };
  }
  if (type === "login_submit") {
    if (unexpectedKeys(value, ["type", "actionId", "kind", "value"])) {
      return { ok: false };
    }
    if (
      !isClientId(value.actionId) ||
      typeof value.kind !== "string" ||
      !LOGIN_INPUT_KINDS.has(value.kind as LoginInputKind) ||
      typeof value.value !== "string" ||
      value.value.length < 1 ||
      value.value.length > 200
    ) {
      return { ok: false };
    }
    const action: LoginSubmitAction = {
      type: "login_submit",
      actionId: value.actionId,
      kind: value.kind as LoginInputKind,
      value: value.value,
    };
    return { ok: true, action, fingerprint: fingerprintOf(action) };
  }
  if (type === "select_model") {
    if (unexpectedKeys(value, ["type", "actionId", "modelId"])) {
      return { ok: false };
    }
    if (!isClientId(value.actionId) || !isModelId(value.modelId)) {
      return { ok: false };
    }
    const action: SelectModelAction = {
      type: "select_model",
      actionId: value.actionId,
      modelId: value.modelId,
    };
    return { ok: true, action, fingerprint: fingerprintOf(action) };
  }
  if (type === "send_message") {
    if (unexpectedKeys(value, ["type", "actionId", "requestId", "clientRequestId", "modelId", "text"])) {
      return { ok: false };
    }
    if (
      !isClientId(value.actionId) ||
      !isClientId(value.requestId) ||
      !isClientId(value.clientRequestId) ||
      !isModelId(value.modelId) ||
      typeof value.text !== "string" ||
      value.text.length < 1 ||
      value.text.length > 8000
    ) {
      return { ok: false };
    }
    const action: SendMessageAction = {
      type: "send_message",
      actionId: value.actionId,
      requestId: value.requestId,
      clientRequestId: value.clientRequestId,
      modelId: value.modelId,
      text: value.text,
    };
    return { ok: true, action, fingerprint: fingerprintOf(action) };
  }
  if (type === "cancel") {
    if (unexpectedKeys(value, ["type", "actionId", "requestId"])) {
      return { ok: false };
    }
    if (!isClientId(value.actionId) || !isClientId(value.requestId)) {
      return { ok: false };
    }
    const action: CancelAction = {
      type: "cancel",
      actionId: value.actionId,
      requestId: value.requestId,
    };
    return { ok: true, action, fingerprint: fingerprintOf(action) };
  }
  if (type === "browser_navigate") {
    if (unexpectedKeys(value, ["type", "actionId", "url"])) {
      return { ok: false };
    }
    if (!isClientId(value.actionId) || typeof value.url !== "string" || value.url.length < 1 || value.url.length > 2000) {
      return { ok: false };
    }
    const action: BrowserNavigateAction = { type: "browser_navigate", actionId: value.actionId, url: value.url };
    return { ok: true, action, fingerprint: fingerprintOf(action) };
  }
  if (type === "browser_read" || type === "browser_screenshot") {
    if (unexpectedKeys(value, ["type", "actionId"])) {
      return { ok: false };
    }
    if (!isClientId(value.actionId)) {
      return { ok: false };
    }
    const action: BrowserReadAction | BrowserScreenshotAction = {
      type,
      actionId: value.actionId,
    };
    return { ok: true, action, fingerprint: fingerprintOf(action) };
  }
  if (type === "browser_click") {
    if (unexpectedKeys(value, ["type", "actionId", "x", "y"])) {
      return { ok: false };
    }
    if (!isClientId(value.actionId) || !isViewportCoordinate(value.x) || !isViewportCoordinate(value.y)) {
      return { ok: false };
    }
    const action: BrowserClickAction = { type: "browser_click", actionId: value.actionId, x: value.x, y: value.y };
    return { ok: true, action, fingerprint: fingerprintOf(action) };
  }
  return { ok: false };
}

function isViewportCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4000;
}
