import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNavigationAllowed, NavigationRejectedError, type OriginRule } from "./allowlist.ts";
import type { LoginInputKind } from "../types.ts";

export class BrowserHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserHostError";
  }
}

export class AutomaticActionStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomaticActionStopped";
  }
}

interface CdpPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PageSession {
  browserContextId: string;
  targetId: string;
  sessionId: string;
  closed: boolean;
}

interface OwnedPage {
  page: PageSession;
}

/**
 * One Chrome process, controlled over its stdio pipe.
 * There is no TCP debugging port. The host does not spoof identity,
 * import cookies, or choose a proxy.
 */
export class BrowserHost {
  private readonly pages = new Map<string, OwnedPage>();
  private closed = false;

  private constructor(
    private readonly process: ChildProcess,
    private readonly userDataDir: string,
    private readonly rules: readonly OriginRule[],
    private readonly send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>,
    private readonly waitFor: (method: string, sessionId: string, timeoutMs: number) => Promise<void>,
  ) {}

  get openSessionCount(): number {
    return this.pages.size;
  }

  static async launch(options: {
    executable: string;
    allowlist: readonly OriginRule[];
    headless: boolean;
    launchTimeoutMs?: number;
  }): Promise<BrowserHost> {
    const userDataDir = await mkdtemp(join(tmpdir(), "remote-claude-browser-"));
    const args = [
      options.headless ? "--headless=new" : "--use-gl=angle",
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "about:blank",
    ];
    const child = spawn(options.executable, args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    const pipeWrite = child.stdio[3];
    const pipeRead = child.stdio[4];
    if (!pipeWrite || !pipeRead || !("write" in pipeWrite) || !("on" in pipeRead)) {
      child.kill("SIGKILL");
      await rm(userDataDir, { recursive: true, force: true });
      throw new BrowserHostError("Browser pipe was not available.");
    }
    const { send, waitFor } = createPipeCdp(pipeRead as Readable, pipeWrite as Writable);
    const host = new BrowserHost(child, userDataDir, options.allowlist, send, waitFor);
    try {
      await waitUntilReady(child, send, options.launchTimeoutMs ?? 15_000);
      return host;
    } catch (error) {
      await host.shutdown();
      if (error instanceof BrowserHostError) {
        throw error;
      }
      throw new BrowserHostError("Browser pipe was not ready.");
    }
  }

  async openSession(ownerId: string): Promise<void> {
    if (this.closed) {
      throw new BrowserHostError("Browser host is shut down.");
    }
    if (this.pages.has(ownerId)) {
      return;
    }
    const created = (await this.send("Target.createBrowserContext", {})) as { browserContextId: string };
    let targetId = "";
    try {
      const target = (await this.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: created.browserContextId,
      })) as { targetId: string };
      targetId = target.targetId;
      const attached = (await this.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      })) as { sessionId: string };
      const page: PageSession = {
        browserContextId: created.browserContextId,
        targetId: target.targetId,
        sessionId: attached.sessionId,
        closed: false,
      };
      await this.send("Page.enable", {}, page.sessionId);
      this.pages.set(ownerId, { page });
    } catch (error) {
      if (targetId) {
        await this.send("Target.closeTarget", { targetId }).catch(() => undefined);
      }
      await this.send("Target.disposeBrowserContext", { browserContextId: created.browserContextId }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async closeSession(ownerId: string): Promise<"attempted" | "not_found"> {
    const owned = this.pages.get(ownerId);
    if (!owned) {
      return "not_found";
    }
    owned.page.closed = true;
    this.pages.delete(ownerId);
    await this.disposePage(owned.page);
    return "attempted";
  }

  async navigate(ownerId: string, url: string, timeoutMs = 10_000): Promise<{ title: string; visibleText: string }> {
    assertNavigationAllowed(url, this.rules);
    const page = this.requireOpen(ownerId);
    const loaded = this.waitFor("Page.loadEventFired", page.sessionId, timeoutMs);
    loaded.catch(() => undefined);
    await this.send("Page.navigate", { url }, page.sessionId);
    await loaded;
    this.requireOpen(ownerId);
    const finalUrl = await this.evaluate(page.sessionId, "location.href");
    if (typeof finalUrl === "string") {
      try {
        assertNavigationAllowed(finalUrl, this.rules);
      } catch (error) {
        await this.stopLoading(page.sessionId);
        throw new NavigationRejectedError("Browser navigation target was rejected.", "attempted");
      }
    }
    const title = await this.evaluate(page.sessionId, "document.title");
    const visibleText = await this.evaluate(page.sessionId, "document.body ? document.body.innerText : ''");
    if (
      typeof title === "string" &&
      /just a moment|attention required|access denied|forbidden|expired|unrecognized/i.test(title)
    ) {
      await this.stopLoading(page.sessionId);
      throw new AutomaticActionStopped("Automatic browser action stopped. No fallback was used.");
    }
    return {
      title: typeof title === "string" ? title : "",
      visibleText: typeof visibleText === "string" ? visibleText : "",
    };
  }

  async click(ownerId: string, x: number, y: number): Promise<void> {
    const page = this.requireOpen(ownerId);
    await this.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      page.sessionId,
    );
    await this.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
      page.sessionId,
    );
  }

  async listLoginInputs(ownerId: string): Promise<LoginInputKind[]> {
    const page = this.requireOpen(ownerId);
    const value = await this.evaluate(page.sessionId, LIST_LOGIN_INPUTS);
    const allowed: LoginInputKind[] = ["email_address", "verification_code"];
    if (!Array.isArray(value)) {
      return [];
    }
    return allowed.filter((kind) => value.includes(kind));
  }

  async submitLoginInput(ownerId: string, kind: LoginInputKind, value: string): Promise<"applied" | "missing"> {
    const page = this.requireOpen(ownerId);
    const result = await this.evaluate(page.sessionId, `(${SUBMIT_LOGIN_INPUT})(${JSON.stringify(kind)},${JSON.stringify(value)})`);
    return result === "applied" ? "applied" : "missing";
  }

  async read(ownerId: string): Promise<{ title: string; visibleText: string }> {
    const page = this.requireOpen(ownerId);
    const title = await this.evaluate(page.sessionId, "document.title");
    const visibleText = await this.evaluate(page.sessionId, "document.body ? document.body.innerText : ''");
    return {
      title: typeof title === "string" ? title : "",
      visibleText: typeof visibleText === "string" ? visibleText : "",
    };
  }

  async screenshot(ownerId: string): Promise<string> {
    const page = this.requireOpen(ownerId);
    const result = (await this.send("Page.captureScreenshot", { format: "png" }, page.sessionId)) as { data?: string };
    if (!result.data || result.data.length > 1_500_000) {
      throw new BrowserHostError("Browser screenshot was empty or too large.");
    }
    return result.data;
  }

  async openIsolatedPage(url: string, timeoutMs = 10_000): Promise<{ text: string; close: () => Promise<void> }> {
    const ownerId = `temp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.openSession(ownerId);
    try {
      const viewed = await this.navigate(ownerId, url, timeoutMs);
      return { text: viewed.visibleText, close: () => this.closeSession(ownerId).then(() => undefined) };
    } catch (error) {
      await this.closeSession(ownerId);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const ownerId of [...this.pages.keys()]) {
      await this.closeSession(ownerId);
    }
    if (this.process.exitCode === null && this.process.pid) {
      try {
        process.kill(-this.process.pid, "SIGKILL");
      } catch {
        this.process.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
    }
    await rm(this.userDataDir, { recursive: true, force: true });
  }

  private requireOpen(ownerId: string): PageSession {
    const owned = this.pages.get(ownerId);
    if (!owned || owned.page.closed) {
      throw new BrowserHostError("Session browser was released.");
    }
    return owned.page;
  }

  private async stopLoading(sessionId: string): Promise<void> {
    await this.send("Page.stopLoading", {}, sessionId).catch(() => undefined);
  }

  private async disposePage(page: PageSession): Promise<void> {
    await this.stopLoading(page.sessionId);
    await Promise.race([
      (async () => {
        await this.send("Target.closeTarget", { targetId: page.targetId }).catch(() => undefined);
        await this.send("Target.disposeBrowserContext", { browserContextId: page.browserContextId }).catch(
          () => undefined,
        );
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  private async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const result = (await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
    )) as { result?: { value?: unknown } };
    return result.result?.value;
  }
}

function createPipeCdp(input: Readable, output: Writable): {
  send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
  waitFor: (method: string, sessionId: string, timeoutMs: number) => Promise<void>;
} {
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  const pending = new Map<number, CdpPending>();
  const waiters: Array<{ method: string; sessionId: string; resolve: () => void }> = [];
  input.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const splitAt = buffer.indexOf(0);
      if (splitAt < 0) {
        break;
      }
      const raw = buffer.subarray(0, splitAt).toString("utf8");
      buffer = buffer.subarray(splitAt + 1);
      if (raw.trim() === "") {
        continue;
      }
      let message: {
        id?: number;
        method?: string;
        sessionId?: string;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(new BrowserHostError("Browser command failed."));
        } else {
          waiter.resolve(message.result);
        }
        continue;
      }
      if (message.method && message.sessionId) {
        const index = waiters.findIndex((item) => item.method === message.method && item.sessionId === message.sessionId);
        if (index >= 0) {
          waiters.splice(index, 1)[0]?.resolve();
        }
      }
    }
  });
  return {
    send(method, params, sessionId) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BrowserHostError("Browser command timed out."));
        }, 5_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        output.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
      });
    },
    waitFor(method, sessionId, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((item) => item.resolve === finish);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new BrowserHostError("Browser page timed out."));
        }, timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        waiters.push({ method, sessionId, resolve: finish });
      });
    },
  };
}

async function waitUntilReady(
  child: ChildProcess,
  send: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exitError: Error | null = null;
  child.once("exit", () => {
    exitError = new BrowserHostError("Browser exited before it was ready.");
  });
  while (Date.now() < deadline) {
    if (exitError) {
      throw exitError;
    }
    try {
      await send("Browser.getVersion", {});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new BrowserHostError("Browser pipe was not ready.");
}

const LIST_LOGIN_INPUTS = `(() => {
  const allowed = ["email_address", "verification_code"];
  const found = [];
  for (const el of document.querySelectorAll("[data-gateway-input]")) {
    const kind = el.getAttribute("data-gateway-input");
    if (!allowed.includes(kind)) continue;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) continue;
    if (el.type === "password") continue;
    if (!found.includes(kind)) found.push(kind);
  }
  return found;
})()`;

const SUBMIT_LOGIN_INPUT = `function submitLoginInput(kind, incoming) {
  if (kind !== "email_address" && kind !== "verification_code") return "missing";
  const el = document.querySelector('[data-gateway-input="' + kind + '"]');
  if (!el || el.getAttribute("data-gateway-input") !== kind) return "missing";
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return "missing";
  if (el.type === "password") return "missing";
  el.focus();
  el.value = incoming;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "applied";
}`;

export { NavigationRejectedError };
