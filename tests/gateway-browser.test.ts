import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { parseAllowlist } from "../server/src/browser/allowlist.ts";
import { BrowserHost } from "../server/src/browser/host.ts";
import { createGatewayApp } from "../server/src/http.ts";
import { authHeaders, readJson } from "./support.ts";

const executable = process.env.BROWSER_EXECUTABLE?.trim() || "google-chrome";
const token = "gateway-browser-token-1";

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body style="margin:0">${body}</body></html>`;
}

async function startFixture(): Promise<{ origin: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/redirect-off") {
      res.writeHead(302, { location: "http://127.0.0.1:9/off-allowlist" });
      res.end();
      return;
    }
    respond(res, url.pathname, url.searchParams.get("write") === "1");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture failed");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function respond(res: ServerResponse, pathname: string, write: boolean): void {
  if (pathname === "/challenge") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Just a moment...", "<p>challenge fixture</p>"));
    return;
  }
  if (pathname === "/forbidden") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Access denied", "<p>forbidden fixture</p>"));
    return;
  }
  if (pathname === "/expired") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Session expired", "<p>expired fixture</p>"));
    return;
  }
  const stored = write ? "localStorage.setItem('fixtureToken','fixture-only-value');" : "";
  const body = `<p id="out">idle</p><button id="mark" style="position:absolute;left:0;top:40px;width:240px;height:80px" onclick="document.getElementById('out').textContent='fixture-marked'">Mark</button><p>local fixture, not Claude</p><script>${stored}document.getElementById('out').textContent=localStorage.getItem('fixtureToken')||document.getElementById('out').textContent;</script>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page("Local fixture", body));
}

test("browser adapter without a host rejects browser actions and does not pretend to log in", async () => {
  const app = createGatewayApp({ adapter: "browser", token });
  const port = await app.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;
  try {
    const created = await readJson(
      await fetch(`${origin}/sessions`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(created.status, 201);
    const sessionId = created.body.session.sessionId as string;
    const navigated = await readJson(
      await fetch(`${origin}/sessions/${sessionId}/actions`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({ type: "browser_navigate", actionId: "nav-disabled", url: "http://127.0.0.1/" }),
      }),
    );
    assert.equal(navigated.status, 503);
    assert.equal(navigated.body.error.code, "browser_host_disabled");
    assert.equal(navigated.body.session.models.length, 0);
    assert.equal(navigated.body.session.claudeUsable, false);
  } finally {
    await app.close();
  }
});

test("authenticated gateway controls an isolated local fixture and does not treat it as Claude", async () => {
  const fixture = await startFixture();
  const host = await BrowserHost.launch({
    executable,
    allowlist: parseAllowlist(fixture.origin),
    headless: true,
  });
  const audit: unknown[] = [];
  const app = createGatewayApp({
    adapter: "browser",
    token,
    browserHost: host,
    audit: (record) => audit.push(record),
  });
  const port = await app.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${origin}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 401);
    assert.equal(host.openSessionCount, 0);

    const first = await create(origin);
    const second = await create(origin);
    assert.equal(host.openSessionCount, 2);
    assert.notEqual(first, second);

    const stored = await action(origin, first, {
      type: "browser_navigate",
      actionId: "nav-store",
      url: `${fixture.origin}/?write=1`,
    });
    assert.equal(stored.status, 200);
    assert.equal(stored.body.browser.localAck, true);
    assert.equal(stored.body.browser.siteAck, false);
    assert.equal(stored.body.browser.claudeLoginVerified, false);
    assert.equal(stored.body.browser.visibleText.includes("fixture-only-value"), true);
    assert.equal(stored.body.session.login.state, "unauthenticated");
    assert.deepEqual(stored.body.session.models, []);
    assert.equal(stored.body.session.claudeUsable, false);

    const other = await action(origin, second, {
      type: "browser_navigate",
      actionId: "nav-other",
      url: `${fixture.origin}/`,
    });
    assert.equal(other.status, 200);
    assert.equal(other.body.browser.visibleText.includes("fixture-only-value"), false);
    assert.equal(other.body.browser.visibleText.includes("idle"), true);

    const clicked = await action(origin, second, {
      type: "browser_click",
      actionId: "click-mark",
      x: 30,
      y: 70,
    });
    assert.equal(clicked.status, 200);
    assert.equal(clicked.body.browser.siteAck, false);
    assert.equal(clicked.body.browser.visibleText.includes("fixture-marked"), true);
    const firstStill = await action(origin, first, { type: "browser_read", actionId: "read-first" });
    assert.equal(firstStill.body.browser.visibleText.includes("fixture-marked"), false);

    const shot = await action(origin, second, { type: "browser_screenshot", actionId: "shot-1" });
    assert.equal(shot.status, 200);
    assert.equal(String(shot.body.browser.screenshotPngBase64).startsWith("iVBORw0KGgo"), true);
    assert.equal(JSON.stringify(audit).includes("iVBORw0KGgo"), false);

    const before = fixture.hits();
    const rejected = await action(origin, second, {
      type: "browser_navigate",
      actionId: "nav-off",
      url: "http://127.0.0.1:9/not-ours",
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "navigation_rejected");
    assert.equal(rejected.body.browser.pageStop, "not_attempted");
    assert.equal(rejected.body.browser.upstream, "unknown");
    assert.equal(fixture.hits(), before);

    const redirected = await action(origin, second, {
      type: "browser_navigate",
      actionId: "nav-redirect",
      url: `${fixture.origin}/redirect-off`,
    });
    assert.equal(redirected.status, 409);
    assert.equal(redirected.body.error.code, "navigation_rejected");
    assert.equal(redirected.body.browser.pageStop, "attempted");

    for (const [id, path] of [
      ["nav-challenge", "/challenge"],
      ["nav-forbidden", "/forbidden"],
      ["nav-expired", "/expired"],
    ] as const) {
      const stopped = await action(origin, second, {
        type: "browser_navigate",
        actionId: id,
        url: `${fixture.origin}${path}`,
      });
      assert.equal(stopped.status, 409);
      assert.equal(stopped.body.error.code, "automatic_action_stopped");
      assert.equal(stopped.body.browser.claudeLoginVerified, false);
      assert.equal(stopped.body.session.models.length, 0);
    }

    const login = await action(origin, first, {
      type: "login_input",
      actionId: "login-1",
      step: "start",
    });
    assert.equal(login.status, 501);
    assert.equal(login.body.error.code, "login_method_unavailable");
    assert.equal(login.body.session.login.state, "unauthenticated");

    const selected = await action(origin, first, {
      type: "select_model",
      actionId: "model-1",
      modelId: "sim.echo",
    });
    assert.equal(selected.status, 501);
    assert.equal(selected.body.error.code, "not_configured");

    const sent = await action(origin, first, {
      type: "send_message",
      actionId: "send-1",
      requestId: "req-1",
      clientRequestId: "client-1",
      modelId: "sim.echo",
      text: "do-not-send",
    });
    assert.equal(sent.status, 501);
    assert.equal(sent.body.error.code, "not_configured");

    const removed = await fetch(`${origin}/sessions/${first}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(removed.status, 204);
    assert.equal(host.openSessionCount, 1);
    const late = await action(origin, first, { type: "browser_read", actionId: "late-read" });
    assert.equal(late.status, 404);
    assert.equal(late.body.error.code, "session_not_found");
    const survivor = await action(origin, second, { type: "browser_read", actionId: "survivor" });
    assert.equal(survivor.status, 200);
    await fetch(`${origin}/sessions/${second}`, { method: "DELETE", headers: authHeaders(token) });
    assert.equal(host.openSessionCount, 0);
  } finally {
    await app.close();
    await fixture.close();
  }
});

async function create(origin: string): Promise<string> {
  const created = await readJson(
    await fetch(`${origin}/sessions`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(created.status, 201);
  return created.body.session.sessionId as string;
}

async function action(origin: string, sessionId: string, body: Record<string, unknown>) {
  return readJson(
    await fetch(`${origin}/sessions/${sessionId}/actions`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
