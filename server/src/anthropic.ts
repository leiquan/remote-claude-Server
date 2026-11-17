import type { ModelDescriptor } from "./types.ts";
import type { OfficialApiConfig } from "./config.ts";

const ERROR_TYPES = new Set([
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "overloaded_error",
  "invalid_request_error",
  "api_error",
  "timeout_error",
  "request_too_large",
]);

export class OfficialApiError extends Error {
  constructor(readonly code: "api_not_configured" | "api_upstream_rejected" | "model_unavailable") {
    super(code);
    this.name = "OfficialApiError";
  }
}

export interface ListedModel {
  id: string;
  displayName: string;
}

/**
 * Official Messages API client. It never logs the key, prompt, response, or host.
 * Callers pass a base URL; tests point that at a local stand-in.
 */
export class AnthropicMessages {
  constructor(private readonly config: OfficialApiConfig) {}

  get configured(): boolean {
    return this.config.apiKey !== null;
  }

  async listModels(signal: AbortSignal): Promise<ListedModel[]> {
    const key = this.requireKey();
    const models: ListedModel[] = [];
    let after: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const url = new URL("/v1/models", this.config.baseUrl);
      url.searchParams.set("limit", "20");
      if (after) {
        url.searchParams.set("after_id", after);
      }
      const response = await this.request(url, { method: "GET", signal, key });
      const body = await readJson(response);
      const data = Array.isArray(body.data) ? body.data : [];
      for (const item of data) {
        const model = readModel(item);
        if (model) {
          models.push(model);
        }
      }
      if (body.has_more !== true || typeof body.last_id !== "string" || body.last_id.length === 0) {
        break;
      }
      after = body.last_id;
    }
    return models;
  }

  async streamMessage(input: {
    model: string;
    text: string;
    signal: AbortSignal;
    onText: (text: string) => void;
  }): Promise<void> {
    const key = this.requireKey();
    const url = new URL("/v1/messages", this.config.baseUrl);
    const response = await this.request(url, {
      method: "POST",
      signal: input.signal,
      key,
      body: JSON.stringify({
        model: input.model,
        max_tokens: this.config.maxTokens,
        stream: true,
        messages: [{ role: "user", content: input.text }],
      }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      throw new OfficialApiError("api_upstream_rejected");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let splitAt = buffer.indexOf("\n\n");
      while (splitAt >= 0) {
        const raw = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        handleEvent(raw, input.onText);
        splitAt = buffer.indexOf("\n\n");
      }
    }
  }

  private requireKey(): string {
    if (!this.config.apiKey) {
      throw new OfficialApiError("api_not_configured");
    }
    return this.config.apiKey;
  }

  private async request(
    url: URL,
    init: { method: "GET" | "POST"; signal: AbortSignal; key: string; body?: string },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        redirect: "error",
        signal: init.signal,
        headers: {
          "x-api-key": init.key,
          "anthropic-version": this.config.version,
          "content-type": "application/json",
        },
        body: init.body,
      });
    } catch {
      throw new OfficialApiError("api_upstream_rejected");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OfficialApiError(response.status === 404 ? "model_unavailable" : "api_upstream_rejected");
    }
    return response;
  }
}

export function toDescriptors(models: readonly ListedModel[]): ModelDescriptor[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    available: true,
    simulated: false,
  }));
}

function readModel(value: unknown): ListedModel | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  const displayName = (value as { display_name?: unknown }).display_name;
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
    return null;
  }
  const name = typeof displayName === "string" && displayName.trim() !== "" ? displayName.trim().slice(0, 200) : id;
  return { id, displayName: name };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new OfficialApiError("api_upstream_rejected");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OfficialApiError) {
      throw error;
    }
    throw new OfficialApiError("api_upstream_rejected");
  }
}

function handleEvent(raw: string, onText: (text: string) => void): void {
  let eventName = "";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }
  if (data === "" || data === "[DONE]") {
    return;
  }
  let parsed: { type?: string; delta?: { type?: string; text?: string }; error?: { type?: string } };
  try {
    parsed = JSON.parse(data) as typeof parsed;
  } catch {
    throw new OfficialApiError("api_upstream_rejected");
  }
  const type = eventName || parsed.type || "";
  if (type === "error" || parsed.type === "error") {
    const kind = parsed.error?.type;
    if (kind && ERROR_TYPES.has(kind)) {
      throw new OfficialApiError(kind === "not_found_error" ? "model_unavailable" : "api_upstream_rejected");
    }
    throw new OfficialApiError("api_upstream_rejected");
  }
  if (type === "content_block_delta" && parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
    if (parsed.delta.text.length > 0) {
      onText(parsed.delta.text);
    }
  }
}
