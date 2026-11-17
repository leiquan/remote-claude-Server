import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../server/src/config.ts";
import { authHeaders, readJson, startGateway } from "./support.ts";

const CANARY = "operator-password-must-not-be-logged";

test("browser adapter reports blocked login and does not authenticate", async () => {
  const gateway = await startGateway({ adapter: "browser" });
  try {
    const health = await readJson(await fetch(gateway.url("/health")));
    assert.equal(health.status, 200);
    assert.equal(health.body.adapter, "browser");
    assert.equal(health.body.claudeUsable, false);
    assert.equal(health.body.capabilities.claudeWebsiteLogin, "not_configured");
    assert.equal(health.body.browserLogin.passwordLogin, "unsupported");
    assert.equal(health.body.browserLogin.verified, false);
    assert.equal(health.body.browserLogin.automatedAccess, "blocked");
    assert.equal(health.body.browserLogin.blocker, "cloudflare_challenge");
    assert.equal(health.text.includes("http"), false);

    const created = await readJson(
      await fetch(gateway.url("/sessions"), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: "{}",
      }),
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.session.login.state, "unauthenticated");
    assert.deepEqual(created.body.session.login.allowedActions, []);
    assert.deepEqual(created.body.session.models, []);

    const sessionId = created.body.session.sessionId as string;
    const login = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}/actions`), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          type: "login_input",
          actionId: "browser-login-1",
          step: "verification",
          simulationResult: "authenticated",
        }),
      }),
    );
    assert.equal(login.status, 501);
    assert.equal(login.body.error.code, "login_method_unavailable");
    assert.equal(login.body.session.login.state, "unauthenticated");
    assert.equal(login.body.session.login.simulated, false);
    assert.equal(login.text.includes("http"), false);
    assert.equal(JSON.stringify(gateway.audit).includes(CANARY), false);

    const leaked = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}/actions`), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          type: "login_input",
          actionId: "browser-login-2",
          step: "start",
          password: CANARY,
        }),
      }),
    );
    assert.equal(leaked.status, 400);
    assert.equal(leaked.body.error.code, "payload_rejected");
    assert.equal(leaked.text.includes(CANARY), false);
    assert.equal(JSON.stringify(gateway.audit).includes(CANARY), false);
  } finally {
    await gateway.close();
  }
});

test("browser is an explicit adapter and the default stays unconfigured", () => {
  assert.equal(loadConfig({}).adapter, "unconfigured");
  assert.equal(loadConfig({ REMOTE_CLAUDE_ADAPTER: "browser" }).adapter, "browser");
  const healthProbe = loadConfig({ REMOTE_CLAUDE_ADAPTER: "browser" });
  assert.equal(healthProbe.adapter, "browser");
});
