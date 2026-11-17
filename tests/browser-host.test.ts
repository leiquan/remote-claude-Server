import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { parseAllowlist } from "../server/src/browser/allowlist.ts";
import { BrowserHost, BrowserHostError } from "../server/src/browser/host.ts";
import { createGatewayApp } from "../server/src/http.ts";

const executable = process.env.BROWSER_EXECUTABLE?.trim() || "google-chrome";

function fixturePage(write: boolean): string {
  const value = write ? "fixture-only-value" : "";
  const stored = write
    ? "localStorage.setItem('fixtureToken','fixture-only-value');"
    : "";
  return `<!doctype html><html><body><p id="out">pending</p><script>${stored}document.getElementById('out').textContent=localStorage.getItem('fixtureToken')||'empty';</script></body></html>`;
}

async function startFixture(): Promise<{ origin: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    const write = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("write") === "1";
    const body = fixturePage(write);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture failed");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("real browser contexts stay isolated on a local fixture and reject other origins", async () => {
  const fixture = await startFixture();
  const host = await BrowserHost.launch({
    executable,
    allowlist: parseAllowlist(fixture.origin),
    headless: true,
  });
  try {
    const first = await host.openIsolatedPage(`${fixture.origin}/?write=1`);
    assert.equal(first.text.trim(), "fixture-only-value");
    await first.close();
    const second = await host.openIsolatedPage(`${fixture.origin}/`);
    assert.equal(second.text.trim(), "empty");
    await second.close();
    const before = fixture.hits();
    await assert.rejects(
      host.openIsolatedPage("http://127.0.0.1:9/not-this-fixture"),
      (error: unknown) => error instanceof Error && error.name === "NavigationRejectedError",
    );
    await assert.rejects(
      host.openIsolatedPage("https://example.invalid/page"),
      (error: unknown) => error instanceof Error && error.name === "NavigationRejectedError",
    );
    assert.equal(fixture.hits(), before);
  } finally {
    await host.shutdown();
    await fixture.close();
  }
});

test("browser page timeout and shutdown release the process", async () => {
  const hanging = createServer((_req, res) => {
    void res;
  });
  await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", () => resolve()));
  const address = hanging.address();
  if (!address || typeof address === "string") {
    throw new Error("hang fixture failed");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const host = await BrowserHost.launch({
    executable,
    allowlist: parseAllowlist(origin),
    headless: true,
  });
  try {
    await assert.rejects(host.openIsolatedPage(`${origin}/hang`, 500), BrowserHostError);
  } finally {
    await host.shutdown();
    await new Promise<void>((resolve, reject) => hanging.close((error) => (error ? reject(error) : resolve())));
  }
});

test("default gateway does not launch a browser or enable Claude navigation", async () => {
  const app = createGatewayApp({ adapter: "browser", token: "review-token-a-0001" });
  const port = await app.listen(0, "127.0.0.1");
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    assert.equal(health.browserHost.running, false);
    assert.equal(health.browserHost.claudeNavigation, "disabled");
    assert.equal(health.browserHost.liveLoginVerified, false);
    assert.equal(health.claudeUsable, false);
  } finally {
    await app.close();
  }
});
