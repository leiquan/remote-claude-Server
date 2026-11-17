/**
 * Detect credential-shaped keys anywhere in a JSON value.
 * Values are never copied into errors or logs by this check.
 */

const NORMALIZED_SECRET_KEYS = new Set([
  "password",
  "passwd",
  "cookie",
  "cookies",
  "setcookie",
  "authorization",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessionkey",
  "claudetoken",
  "apikey",
  "bearer",
  "sessionid",
  "sessioncookie",
  "idtoken",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

export function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsCredentialKey(item));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (NORMALIZED_SECRET_KEYS.has(normalizeKey(key))) {
      return true;
    }
    if (containsCredentialKey(child)) {
      return true;
    }
  }
  return false;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export function isClientId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = ownKeys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
