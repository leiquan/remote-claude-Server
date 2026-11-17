import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_GATEWAY_TOKEN } from "../server/src/token.ts";
import { loadConfig } from "../server/src/config.ts";
import { authHeaders, openSse, rawRequest, readJson, startGateway } from "./support.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANARY = "canary-credential-do-not-log";

test("health is local protocol detection and does not claim Claude is usable", async () => {
  const gateway = await startGateway({ adapter: "unconfigured", token: null });
  try {
    const response = await fetch(gateway.url("/health"));
    const body = await readJson(response);
    assert.equal(body.status, 200);
    assert.equal(body.body.serviceId, "remote-claude-gateway");
    assert.equal(body.body.protocolVersion, "0");
    assert.equal(body.body.claudeUsable, false);
    assert.equal(body.body.adapter, "unconfigured");
    assert.equal(body.body.capabilities.protocolDetection, "supported");
    assert.equal(body.body.capabilities.gatewayAuth, "not_configured");
    assert.equal(body.body.capabilities.claudeWebsiteLogin, "not_configured");
    assert.equal(body.body.capabilities.liveModelCatalog, "not_configured");
    assert.equal(body.body.capabilities.liveConversation, "not_configured");
    assert.equal(body.body.authentication.thisResponseAuthorizesControl, false);
    assert.equal(body.text.includes("claude.ai"), false);
    assert.equal(response.headers.get("set-cookie"), null);
  } finally {
    await gateway.close();
  }
});

test("control routes require the gateway token and do not reveal session existence", async () => {
  const gateway = await startGateway({ adapter: "unconfigured" });
  try {
    const created = await readJson(
      await fetch(gateway.url("/sessions"), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: "{}",
      }),
    );
    assert.equal(created.status, 201);
    const sessionId = created.body.session.sessionId as string;
    const missingId = "ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const existingResponse = await fetch(gateway.url(`/sessions/${sessionId}/events`));
    const missingResponse = await fetch(gateway.url(`/sessions/${missingId}/events`));
    const existing = await readJson(existingResponse);
    const missing = await readJson(missingResponse);
    assert.equal(existing.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(existing.body.error.code, "auth_required");
    assert.deepEqual(existing.body, missing.body);
    assert.equal(existing.text.includes("login"), false);
    assert.match(existingResponse.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(existingResponse.headers.get("content-type")?.includes("text/event-stream"), false);

    const wrong = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}`), {
        headers: authHeaders("not-the-gateway-token-value"),
      }),
    );
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "auth_invalid");
    assert.equal(wrong.text.includes(gateway.token ?? ""), false);

    const unknown = await readJson(
      await fetch(gateway.url(`/sessions/${missingId}`), { headers: authHeaders(gateway.token) }),
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "session_not_found");
  } finally {
    await gateway.close();
  }
});

test("unconfigured adapter never authenticates, lists models, or accepts credential fields", async () => {
  const gateway = await startGateway({ adapter: "unconfigured" });
  try {
    const created = await readJson(
      await fetch(gateway.url("/sessions"), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: "{}",
      }),
    );
    const session = created.body.session;
    assert.equal(session.login.state, "unauthenticated");
    assert.deepEqual(session.login.allowedActions, []);
    assert.equal(session.login.simulated, false);
    assert.deepEqual(session.models, []);
    assert.equal(session.modelsStatus, "not_configured");
    assert.equal(session.conversation, null);
    assert.equal(session.claudeUsable, false);

    const sessionId = session.sessionId as string;
    const stream = await openSse(gateway.url(`/sessions/${sessionId}/events`), authHeaders(gateway.token));
    const login = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}/actions`), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          type: "login_input",
          actionId: "login-1",
          step: "verification",
          simulationResult: "authenticated",
        }),
      }),
    );
    assert.equal(login.status, 501);
    assert.equal(login.body.error.code, "not_configured");
    assert.equal(login.body.session.login.state, "unauthenticated");
    assert.equal(login.body.status, "rejected");
    assert.equal(JSON.stringify(login.body).includes("http"), false);

    const leaked = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}/actions`), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          type: "login_input",
          actionId: "login-2",
          step: "start",
          password: CANARY,
        }),
      }),
    );
    assert.equal(leaked.status, 400);
    assert.equal(leaked.body.error.code, "payload_rejected");
    assert.equal(leaked.text.includes(CANARY), false);
    assert.equal(JSON.stringify(gateway.audit).includes(CANARY), false);

    const message = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}/actions`), {
        method: "POST",
        headers: authHeaders(gateway.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          type: "send_message",
          actionId: "msg-1",
          requestId: "req-1",
          clientRequestId: "client-1",
          modelId: "sim.echo",
          text: "hello",
        }),
      }),
    );
    assert.equal(message.status, 501);
    assert.equal(message.body.error.code, "not_configured");
    const events = await stream.waitFor((items) => items.some((item) => item.type === "error"), 1000);
    assert.equal(events.some((item) => item.type === "auth_required"), false);
    assert.equal(events.some((item) => item.type === "completed"), false);
    stream.close();

    const again = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}`), { headers: authHeaders(gateway.token) }),
    );
    assert.equal(again.body.session.login.state, "unauthenticated");
    assert.deepEqual(again.body.session.models, []);
  } finally {
    await gateway.close();
  }
});

test("routes stay on one family and reject traversal, encoding, and prefix collisions", async () => {
  const gateway = await startGateway({ adapter: "unconfigured", basePath: "/gateway" });
  try {
    const health = await fetch(gateway.url("/health"));
    assert.equal(health.status, 200);
    const collision = await readJson(await fetch(`${gateway.origin}/gateway-evil/health`));
    assert.equal(collision.status, 404);
    assert.equal(collision.body.error.code, "not_found");
    const versioned = await readJson(await fetch(`${gateway.origin}/v0/health`));
    assert.equal(versioned.status, 404);
    const dot = await rawRequest(gateway.origin, "/gateway/health/../sessions");
    assert.equal(dot.status, 400);
    assert.equal(JSON.parse(dot.text).error.code, "invalid_path");
    const encoded = await rawRequest(gateway.origin, "/gateway/sessions/%2e%2e/events");
    assert.equal(encoded.status, 400);
    assert.equal(JSON.parse(encoded.text).error.code, "invalid_path");
    assert.equal(dot.text.includes("password"), false);
  } finally {
    await gateway.close();
  }
});

test("placeholder token and short token are not usable credentials", () => {
  const placeholder = loadConfig({ GATEWAY_ACCESS_TOKEN: PLACEHOLDER_GATEWAY_TOKEN });
  assert.equal(placeholder.token.token, null);
  assert.equal(placeholder.token.placeholderIgnored, true);
  assert.throws(() => loadConfig({ GATEWAY_ACCESS_TOKEN: "short-token" }), /at least 16/);
  assert.throws(() => loadConfig({ GATEWAY_BASE_PATH: "/gw/../admin" }), /normalized path/);
  assert.throws(() => loadConfig({ REMOTE_CLAUDE_ADAPTER: "claude" }), /unconfigured, mock, browser, or api/);
});

test("entrypoint serves health without printing a token", async () => {
  const port = 43000 + Math.floor(Math.random() * 1000);
  const child = spawn("npx", ["tsx", "server/src/main.ts"], {
    cwd: repoRoot,
    detached: true,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      GATEWAY_BIND_HOST: "127.0.0.1",
      GATEWAY_ACCESS_TOKEN: PLACEHOLDER_GATEWAY_TOKEN,
      REMOTE_CLAUDE_ADAPTER: "unconfigured",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    let startupTimer: NodeJS.Timeout | undefined;
    const ready = await Promise.race([
      once(child.stdout, "data").then(() => true),
      once(child, "exit").then(() => false),
      new Promise<boolean>((resolve) => {
        startupTimer = setTimeout(() => resolve(false), 15_000);
      }),
    ]);
    if (startupTimer) {
      clearTimeout(startupTimer);
    }
    assert.equal(ready, true);
    const announced = JSON.parse(stdout.trim()) as { gatewayTokenConfigured: boolean; claudeUsable: boolean };
    assert.equal(announced.gatewayTokenConfigured, false);
    assert.equal(announced.claudeUsable, false);
    const health = await readJson(await fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(health.status, 200);
    const denied = await readJson(await fetch(`http://127.0.0.1:${port}/sessions`, { method: "POST" }));
    assert.equal(denied.status, 503);
    assert.equal(denied.body.error.code, "auth_not_configured");
    const leaked = await fetch(`http://127.0.0.1:${port}/sessions/ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: CANARY }),
    });
    const leakedText = await leaked.text();
    assert.equal(leakedText.includes(CANARY), false);
    assert.equal(stdout.includes(CANARY), false);
    assert.equal(stderr.includes(CANARY), false);
    assert.equal(stdout.includes(PLACEHOLDER_GATEWAY_TOKEN), false);
  } finally {
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGTERM");
      }
    } catch {
      child.kill("SIGTERM");
    }
    await once(child, "exit");
  }
});

test("sample config and isolation plan stay free of real credentials", async () => {
  const sample = await readFile(path.join(repoRoot, "server/config.sample.env"), "utf8");
  assert.match(sample, /REPLACE_WITH_GATEWAY_ACCESS_TOKEN/);
  assert.equal(sample.includes("sk-"), false);
  const plan = await readFile(path.join(repoRoot, "contracts/client-isolation-test-plan.md"), "utf8");
  const markers = plan.match(/NOT EXECUTED ON IOS/g) ?? [];
  assert.ok(markers.length >= 7);
  for (const id of [
    "invalid-unconfigured-unreachable",
    "flows-stay-on-base",
    "redirects-blocked",
    "no-remote-resources",
    "lookalike-and-traversal",
    "timeout-background-reconnect",
    "base-change-generation",
  ]) {
    assert.ok(plan.includes(id), id);
  }
  assert.match(plan, /网关测试不能证明 iOS 隔离/);
});
