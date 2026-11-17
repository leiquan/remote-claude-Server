export interface OriginRule {
  scheme: "http" | "https";
  host: string;
  port: number;
}

export class NavigationRejectedError extends Error {
  readonly pageStop: "not_attempted" | "attempted";

  constructor(message: string, pageStop: "not_attempted" | "attempted" = "not_attempted") {
    super(message);
    this.name = "NavigationRejectedError";
    this.pageStop = pageStop;
  }
}

const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443 };

/**
 * Origins the operator explicitly listed. Matching is scheme + host + effective port.
 * This list is never filled with a third-party site by the program.
 */
export function parseAllowlist(raw: string | undefined): OriginRule[] {
  if (raw == null || raw.trim() === "") {
    return [];
  }
  return raw.split(",").map((item) => parseOrigin(item.trim()));
}

export function parseOrigin(raw: string): OriginRule {
  if (raw.includes("@") || raw.includes("\\") || raw.includes(" ")) {
    throw new NavigationRejectedError("Browser allowlist origin is not a normalized URL.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NavigationRejectedError("Browser allowlist origin is not a normalized URL.");
  }
  if (url.username || url.password) {
    throw new NavigationRejectedError("Browser allowlist origin is not a normalized URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NavigationRejectedError("Browser allowlist origin is not a normalized URL.");
  }
  const scheme = url.protocol === "https:" ? "https" : "http";
  const host = url.hostname.toLowerCase();
  if (!host || host.endsWith(".") || host.includes("..")) {
    throw new NavigationRejectedError("Browser allowlist origin is not a normalized URL.");
  }
  const port = url.port === "" ? DEFAULT_PORT[scheme] : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NavigationRejectedError("Browser allowlist origin is not a normalized URL.");
  }
  return { scheme, host, port };
}

export function assertNavigationAllowed(target: string, rules: readonly OriginRule[]): void {
  if (rules.length === 0) {
    throw new NavigationRejectedError("Browser navigation is not allowlisted.");
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new NavigationRejectedError("Browser navigation target was rejected.");
  }
  if (url.username || url.password || target.includes("@")) {
    throw new NavigationRejectedError("Browser navigation target was rejected.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NavigationRejectedError("Browser navigation target was rejected.");
  }
  const scheme = url.protocol === "https:" ? "https" : "http";
  const host = url.hostname.toLowerCase();
  const port = url.port === "" ? DEFAULT_PORT[scheme] : Number(url.port);
  const allowed = rules.some((rule) => rule.scheme === scheme && rule.host === host && rule.port === port);
  if (!allowed) {
    throw new NavigationRejectedError("Browser navigation target was rejected.");
  }
}
