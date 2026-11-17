import type { AdapterKind } from "./types.ts";
import { resolveGatewayToken, type ResolvedToken } from "./token.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface GatewayConfig {
  host: string;
  port: number;
  basePath: string;
  adapter: AdapterKind;
  token: ResolvedToken & { ok: true };
  mockSettleMs: number;
  browserHostEnabled: boolean;
  officialApi: OfficialApiConfig;
}

export interface OfficialApiConfig {
  apiKey: string | null;
  baseUrl: string;
  version: string;
  pinnedModelId: string | null;
  maxTokens: number;
  timeoutMs: number;
}

const HOST_PATTERN = /^[a-zA-Z0-9.-]+$/;

export function normalizeBasePath(raw: string | undefined): string {
  if (raw == null || raw === "" || raw === "/") {
    return "";
  }
  if (
    !raw.startsWith("/") ||
    raw.endsWith("/") ||
    raw.includes("//") ||
    raw.includes("\\") ||
    raw.includes("%") ||
    raw.includes("..") ||
    raw.includes("@") ||
    raw.includes(" ") ||
    raw.includes("?")
  ) {
    throw new ConfigError("GATEWAY_BASE_PATH must be an absolute normalized path.");
  }
  return raw;
}

export function normalizeBindHost(raw: string | undefined): string {
  const host = raw == null || raw.trim() === "" ? "127.0.0.1" : raw.trim();
  if (
    host.includes("://") ||
    host.includes("/") ||
    host.includes("@") ||
    host.includes(" ") ||
    !HOST_PATTERN.test(host) ||
    host.includes("..") ||
    host.startsWith(".") ||
    host.endsWith(".")
  ) {
    throw new ConfigError("GATEWAY_BIND_HOST is invalid.");
  }
  return host;
}

export function normalizePort(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") {
    return 43123;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError("GATEWAY_PORT is invalid.");
  }
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError("GATEWAY_PORT is invalid.");
  }
  return port;
}

export function normalizeAdapter(raw: string | undefined): AdapterKind {
  if (raw == null || raw.trim() === "" || raw === "unconfigured") {
    return "unconfigured";
  }
  if (raw === "mock") {
    return "mock";
  }
  if (raw === "browser") {
    return "browser";
  }
  if (raw === "api") {
    return "api";
  }
  throw new ConfigError("REMOTE_CLAUDE_ADAPTER must be unconfigured, mock, browser, or api.");
}

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const token = resolveGatewayToken(env.GATEWAY_ACCESS_TOKEN);
  if (!token.ok) {
    throw new ConfigError(token.message);
  }
  return {
    host: normalizeBindHost(env.GATEWAY_BIND_HOST),
    port: normalizePort(env.GATEWAY_PORT),
    basePath: normalizeBasePath(env.GATEWAY_BASE_PATH),
    adapter: normalizeAdapter(env.REMOTE_CLAUDE_ADAPTER),
    token,
    mockSettleMs: 800,
    browserHostEnabled: normalizeBrowserHost(env.BROWSER_HOST),
    officialApi: loadOfficialApi(env),
  };
}

/** Example version string from the public streaming docs curl, not a model id. */
export const DOCUMENTED_ANTHROPIC_VERSION = "2026-10-21";

export function loadOfficialApi(env: NodeJS.ProcessEnv): OfficialApiConfig {
  return {
    apiKey: normalizeApiKey(env.ANTHROPIC_API_KEY),
    baseUrl: normalizeApiBaseUrl(env.ANTHROPIC_API_BASE_URL),
    version: normalizeApiVersion(env.ANTHROPIC_VERSION),
    pinnedModelId: normalizePinnedModel(env.ANTHROPIC_MODEL),
    maxTokens: normalizeBoundedInt(env.ANTHROPIC_MAX_TOKENS, 256, 1, 1024, "ANTHROPIC_MAX_TOKENS"),
    timeoutMs: normalizeBoundedInt(env.ANTHROPIC_TIMEOUT_MS, 30_000, 1_000, 60_000, "ANTHROPIC_TIMEOUT_MS"),
  };
}

function normalizeApiKey(raw: string | undefined): string | null {
  if (raw == null || raw.trim() === "" || raw.trim() === "REPLACE_WITH_ANTHROPIC_API_KEY") {
    return null;
  }
  const key = raw.trim();
  if (key.length < 16 || key.length > 300 || /\s/.test(key)) {
    throw new ConfigError("ANTHROPIC_API_KEY is invalid.");
  }
  return key;
}

function normalizeApiBaseUrl(raw: string | undefined): string {
  const value = raw == null || raw.trim() === "" ? "https://api.anthropic.com" : raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("ANTHROPIC_API_BASE_URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("ANTHROPIC_API_BASE_URL is invalid.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) {
    return url.toString().replace(/\/$/, "");
  }
  throw new ConfigError("ANTHROPIC_API_BASE_URL is invalid.");
}

function normalizeApiVersion(raw: string | undefined): string {
  const value = raw == null || raw.trim() === "" ? DOCUMENTED_ANTHROPIC_VERSION : raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ConfigError("ANTHROPIC_VERSION is invalid.");
  }
  return value;
}

function normalizePinnedModel(raw: string | undefined): string | null {
  if (raw == null || raw.trim() === "") {
    return null;
  }
  const value = raw.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new ConfigError("ANTHROPIC_MODEL is invalid.");
  }
  return value;
}

function normalizeBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError(`${name} is invalid.`);
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} is invalid.`);
  }
  return value;
}

export function normalizeBrowserHost(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === "" || raw === "disabled") {
    return false;
  }
  if (raw === "enabled") {
    return true;
  }
  throw new ConfigError("BROWSER_HOST must be enabled or disabled.");
}
