import { createHash, timingSafeEqual } from "node:crypto";

export const PLACEHOLDER_GATEWAY_TOKEN = "REPLACE_WITH_GATEWAY_ACCESS_TOKEN";
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 256;

export type ResolvedToken =
  | { ok: true; token: string | null; placeholderIgnored: boolean }
  | { ok: false; message: string };

/**
 * Operator tokens stay in memory only. The sample placeholder is refused
 * so a copied config file cannot become a working credential.
 */
export function resolveGatewayToken(raw: string | undefined): ResolvedToken {
  if (raw == null || raw.trim() === "") {
    return { ok: true, token: null, placeholderIgnored: false };
  }
  const token = raw.trim();
  if (token === PLACEHOLDER_GATEWAY_TOKEN) {
    return { ok: true, token: null, placeholderIgnored: true };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, message: "GATEWAY_ACCESS_TOKEN must be at least 16 characters." };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, message: "GATEWAY_ACCESS_TOKEN is too long." };
  }
  return { ok: true, token, placeholderIgnored: false };
}

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function gatewayTokensMatch(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
