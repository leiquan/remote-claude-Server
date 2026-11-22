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
  cli?: { cwd: string; executable?: string; models: string[] };
  browserHostEnabled: boolean;
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
  if (raw === "cli") return "cli";
  throw new ConfigError("REMOTE_CLAUDE_ADAPTER must be unconfigured, mock, browser, or cli.");
}

export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const token = resolveGatewayToken(env.GATEWAY_ACCESS_TOKEN);
  if (!token.ok) {
    throw new ConfigError(token.message);
  }
  const adapter = normalizeAdapter(env.REMOTE_CLAUDE_ADAPTER);
  let cli: GatewayConfig["cli"];
  if (adapter === "cli") {
    const cwd = env.CLAUDE_CLI_CWD?.trim();
    const models = [...new Set((env.CLAUDE_CLI_MODELS ?? "sonnet,opus,haiku").split(",").map(model => model.trim()))];
    if (!cwd?.startsWith("/")) throw new ConfigError("CLAUDE_CLI_CWD must be an absolute directory.");
    if (models.length > 32 || models.some(model => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(model))) {
      throw new ConfigError("CLAUDE_CLI_MODELS must contain model IDs separated by commas.");
    }
    cli = { cwd, executable: env.CLAUDE_CLI_EXECUTABLE?.trim() || undefined, models };
  }
  return {
    host: normalizeBindHost(env.GATEWAY_BIND_HOST),
    port: normalizePort(env.GATEWAY_PORT),
    basePath: normalizeBasePath(env.GATEWAY_BASE_PATH),
    adapter,
    ...(cli ? { cli } : {}),
    token,
    mockSettleMs: 800,
    browserHostEnabled: normalizeBrowserHost(env.BROWSER_HOST),
  };
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
