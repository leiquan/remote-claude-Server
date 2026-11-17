import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { parseAllowlist } from "../server/src/browser/allowlist.ts";
import { BrowserHost } from "../server/src/browser/host.ts";
import { createGatewayApp } from "../server/src/http.ts";
import { authHeaders, readJson, startGateway } from "./support.ts";

const executable = process.env.BROWSER_EXECUTABLE?.trim() || "google-chrome";
const token = "login-submit-token-01";
const code = "fixture-code-918273";
const secret = "fixture-secret-not-stored";

function fixtureHtml(): string {
  return `<!doctype html><html><head><title>Local fixture</title></head><body style="margin:0">
<p id="status">idle</p>
<input data-gateway-input="email_address" id="email">
<input data-gateway-input="verification_code" id="code">
<input type="password" data-gateway-input="password" id="pw">
<button id="mark" style="position:absolute;left:0;top:80px;width:160px;height:40px" onclick="document.getElementById('status').textContent='fixture-marked'">Mark</button>
<p>local fixture, not Claude</p>
<script>
document.getElementById("code").addEventListener("input", () => {
  document.getElementById("status").textContent = "fixture-code-set";
});
document.getElementById("pw").addEventListener("input", () => {
  document.getElementById("status").textContent = "password-touched";
});
</script>
</body></html>`;
}

test("login submit is refused unless this session context lists the input", async () => {
  const gateway = await startGateway({ adapter: "browser" });
  try {
    const created = await readJson(
      await fetch(gateway.url("/sessions"), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: "{}",
      }),
    );
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.session.login.supportedInputs, []);
    assert.equal(created.body.session.login.passwordLogin, "unsupported");
    const sessionId = created.body.session.sessionId as string;
    const submitted = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}/actions`), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          type: "login_submit",
          actionId: "submit-none",
          kind: "verification_code",
          value: code,
        }),
      }),
    );
    assert.equal(submitted.status, 409);
    assert.equal(submitted.body.error.code, "login_input_unsupported");
    assert.equal(submitted.body.session.login.state, "unauthenticated");
    assert.equal(submitted.body.session.claudeUsable, false);
    assert.equal(submitted.text.includes(code), false);
    assert.equal(JSON.stringify(gateway.audit).includes(code), false);
  } finally {
    await gateway.close();
  }
});

test("authenticated fixture input is session-bound and is not a Claude login", async () => {
  const fixture = await new Promise<{ origin: string; close: () => Promise<void> }>((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fixtureHtml());
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fixture failed"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
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

    const sessionId = await create(origin);
    const otherId = await create(origin);
    const early = await action(origin, sessionId, {
      type: "login_submit",
      actionId: "too-early",
      kind: "verification_code",
      value: code,
    });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "login_input_unsupported");
    assert.equal(early.text.includes(code), false);

    const scripted = await action(origin, sessionId, {
      type: "login_submit",
      actionId: "no-script",
      kind: "verification_code",
      value: code,
      url: "http://127.0.0.1:9/not-a-login-target",
      script: "alert(1)",
    });
    assert.equal(scripted.status, 400);
    assert.equal(scripted.body.error.code, "invalid_action");
    assert.equal(scripted.text.includes(code), false);

    const password = await action(origin, sessionId, {
      type: "login_submit",
      actionId: "no-password",
      kind: "verification_code",
      value: secret,
      password: secret,
    });
    assert.equal(password.status, 400);
    assert.equal(password.body.error.code, "payload_rejected");
    assert.equal(password.text.includes(secret), false);

    const navigated = await action(origin, sessionId, {
      type: "browser_navigate",
      actionId: "nav-fixture",
      url: `${fixture.origin}/`,
    });
    assert.equal(navigated.status, 200);
    assert.equal(navigated.body.browser.claudeLoginVerified, false);
    assert.deepEqual(navigated.body.session.login.supportedInputs, ["email_address", "verification_code"]);
    assert.equal(navigated.body.session.login.passwordLogin, "unsupported");
    assert.equal(navigated.body.session.login.allowedActions.includes("login_submit"), true);
    assert.equal(navigated.body.session.login.state, "unauthenticated");
    assert.equal(navigated.body.session.claudeUsable, false);

    const other = await readJson(await fetch(`${origin}/sessions/${otherId}`, { headers: authHeaders(token) }));
    assert.deepEqual(other.body.session.login.supportedInputs, []);

    const submitted = await action(origin, sessionId, {
      type: "login_submit",
      actionId: "submit-code",
      kind: "verification_code",
      value: code,
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, "accepted");
    assert.equal(submitted.body.browser.localAck, true);
    assert.equal(submitted.body.browser.siteAck, false);
    assert.equal(submitted.body.browser.claudeLoginVerified, false);
    assert.equal(submitted.body.session.login.state, "unauthenticated");
    assert.equal(submitted.body.session.claudeUsable, false);
    assert.equal(submitted.text.includes(code), false);

    const seen = await action(origin, sessionId, { type: "browser_read", actionId: "read-status" });
    assert.equal(seen.body.browser.visibleText.includes("fixture-code-set"), true);
    assert.equal(seen.body.browser.visibleText.includes(code), false);
    assert.equal(seen.body.browser.visibleText.includes("password-touched"), false);
    assert.equal(seen.body.browser.claudeLoginVerified, false);

    const clicked = await action(origin, sessionId, { type: "browser_click", actionId: "click-mark", x: 20, y: 100 });
    assert.equal(clicked.status, 200);
    assert.equal(clicked.body.browser.visibleText.includes("fixture-marked"), true);
    assert.equal(JSON.stringify(audit).includes(code), false);
    assert.equal(JSON.stringify(audit).includes(secret), false);

    const late = await readJson(await fetch(`${origin}/sessions/${sessionId}`, { headers: authHeaders(token) }));
    assert.equal(JSON.stringify(late.body).includes(code), false);
    assert.equal(late.body.session.login.state, "unauthenticated");
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
