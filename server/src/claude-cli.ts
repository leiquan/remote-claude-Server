import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";

export interface ClaudeCliOptions {
  executable?: string;
  cwd: string;
  model?: string;
  onDelta?: (delta: string) => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  resumeSessionId?: string;
}

export interface ClaudeCliResult {
  text: string;
  sessionId: string | null;
}

export const CLI_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClaudeCliError extends Error {
  constructor(readonly code: "cancelled" | "timeout" | "output_limit" | "cli_failed" | "invalid_response") {
    super(code);
    this.name = "ClaudeCliError";
  }
}

/**
 * Runs one non-interactive Claude Code turn. No shell is used and no permission
 * bypass flags are passed. The gateway must authenticate and authorize callers
 * before invoking this bridge. Do not expose cwd or executable to remote clients.
 */
export async function runClaudeTurn(prompt: string, options: ClaudeCliOptions): Promise<ClaudeCliResult> {
  if (!prompt.trim()) throw new TypeError("Prompt must not be empty.");
  if (!options.cwd || !options.cwd.startsWith("/")) throw new TypeError("cwd must be an absolute path.");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Invalid timeout.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new TypeError("Invalid output limit.");
  if (options.resumeSessionId && !CLI_SESSION_ID.test(options.resumeSessionId)) throw new TypeError("Invalid Claude session ID.");
  if (options.signal?.aborted) throw new ClaudeCliError("cancelled");

  return await new Promise<ClaudeCliResult>((resolve, reject) => {
    const streaming = options.onDelta !== undefined;
    const args = ["-p", "--output-format", streaming ? "stream-json" : "json",
      "--permission-mode", "plan", "--tools", "", "--safe-mode", "--disable-slash-commands"];
    if (streaming) args.push("--verbose", "--include-partial-messages");
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--resume", options.resumeSessionId, "--fork-session");
    args.push("--", prompt);
    const env = { ...process.env };
    delete env.GATEWAY_ACCESS_TOKEN;
    const child = spawn(options.executable ?? "claude", args, {
      cwd: options.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let result: Record<string, unknown> | undefined;
    let streamed = false;
    function parseLine(line: string) {
      if (!line.trim()) return;
      const frame = JSON.parse(line);
      if (frame.type === "result") result = frame;
      const event = frame.event;
      if (
        frame.type === "stream_event" && frame.parent_tool_use_id == null &&
        event?.type === "content_block_delta" && event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string" && event.delta.text
      ) {
        streamed = true;
        options.onDelta?.(event.delta.text);
      }
    }
    let bytes = 0;
    let failure: ClaudeCliError | null = null;
    let settled = false;
    const stop = (code: ClaudeCliError["code"]) => {
      failure ??= new ClaudeCliError(code);
      child.kill("SIGKILL");
    };
    const onAbort = () => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) return stop("output_limit");
      if (failure) return;
      if (!streaming) {
        chunks.push(chunk);
        return;
      }
      pending += decoder.write(chunk);
      let end: number;
      try {
        while ((end = pending.indexOf("\n")) >= 0) {
          parseLine(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      } catch {
        stop("invalid_response");
      }
    });
    // Never forward stderr: it can contain prompts, paths or credentials.
    child.stderr.resume();
    child.once("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure ?? new ClaudeCliError("cli_failed"));
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) return reject(failure);
      if (status !== 0) return reject(new ClaudeCliError("cli_failed"));
      try {
        if (streaming) parseLine(pending + decoder.end());
        const parsed: unknown = streaming ? result : JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object") throw new Error("Invalid response");
        const obj = parsed as Record<string, unknown>;
        if (obj.is_error === true || typeof obj.result !== "string") throw new Error("Invalid response");
        if (streaming && !streamed && obj.result) options.onDelta?.(obj.result);
        resolve({ text: obj.result, sessionId: typeof obj.session_id === "string" ? obj.session_id : null });
      } catch {
        reject(new ClaudeCliError("invalid_response"));
      }
    });
  });
}
