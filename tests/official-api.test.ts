import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayApp } from "../server/src/http.ts";
import { authHeaders, openSse, readJson } from "./support.ts";

const token = "official-api-token-01";
const apiKey = "test-api-key-value-1";
const prompt = "user-prompt-canary";

test("official API adapter stays not configured without a key and does not call upstream", async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits += 1;
    res.writeHead(500);
    res.end();
  });
  await listen(upstream);
  const address = upstream.address();
  if (!address || typeof address === "string") {
    throw new Error("upstream failed");
  }
  const app = createGatewayApp({
    adapter: "api",
    token,
    officialApi: {
      apiKey: null,
      baseUrl: `http://127.0.0.1:${address.port}`,
      version: "2026-10-21",
      pinnedModelId: null,
      maxTokens: 256,
      timeoutMs: 5_000,
    },
  });
  const port = await app.listen(0, "127.0.0.1");
  try {
    const health = await readJson(await fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(health.body.officialApi.enabled, true);
    assert.equal(health.body.officialApi.configured, false);
    assert.equal(health.body.officialApi.liveVerified, false);
    assert.equal(health.body.claudeUsable, false);
    const created = await readJson(
      await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.session.models, []);
    assert.equal(created.body.session.modelsStatus, "not_configured");
    assert.equal(created.body.session.capabilities.claudeWebsiteLogin, "not_configured");
    assert.equal(hits, 0);
  } finally {
    await app.close();
    upstream.close();
  }
});

test("local stand-in: list, select, stream, cancel, and hide upstream secrets", async () => {
  let aborted = false;
  const upstream = createServer(async (req, res) => {
    if (req.headers["x-api-key"] !== apiKey) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "authentication_error", message: apiKey } }));
      return;
    }
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { type: "model", id: "model-a", display_name: "Model A", created_at: "2020-01-01T00:00:00Z" },
            { type: "model", id: "model-b", display_name: "Model B", created_at: "2020-01-02T00:00:00Z" },
          ],
          has_more: false,
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      stream?: boolean;
      max_tokens?: number;
      messages?: Array<{ content?: string }>;
    };
    assert.equal(body.stream, true);
    assert.ok((body.max_tokens ?? 0) <= 1024);
    const text = body.messages?.[0]?.content ?? "";
    if (text === "hold") {
      res.on("close", () => {
        aborted = true;
      });
      return;
    }
    if (text === "explode") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: `leak ${prompt}` },
        })}\n\n`,
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      [
        `event: content_block_delta`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}`,
        ``,
        `event: content_block_delta`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hidden-thought" } })}`,
        ``,
        `event: message_stop`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        ``,
        ``,
      ].join("\n"),
    );
  });
  await listen(upstream);
  const address = upstream.address();
  if (!address || typeof address === "string") {
    throw new Error("upstream failed");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const app = createGatewayApp({
    adapter: "api",
    token,
    officialApi: {
      apiKey,
      baseUrl,
      version: "2026-10-21",
      pinnedModelId: null,
      maxTokens: 256,
      timeoutMs: 5_000,
    },
    audit: () => undefined,
  });
  const audit: string[] = [];
  const audited = createGatewayApp({
    adapter: "api",
    token,
    officialApi: {
      apiKey,
      baseUrl,
      version: "2026-10-21",
      pinnedModelId: "model-b",
      maxTokens: 256,
      timeoutMs: 5_000,
    },
    audit: (record) => audit.push(JSON.stringify(record)),
  });
  const port = await app.listen(0, "127.0.0.1");
  const pinnedPort = await audited.listen(0, "127.0.0.1");
  try {
    const origin = `http://127.0.0.1:${port}`;
    const sessionId = await create(origin);
    const session = await readJson(await fetch(`${origin}/sessions/${sessionId}`, { headers: authHeaders(token) }));
    assert.equal(session.body.session.modelsStatus, "api");
    assert.deepEqual(
      session.body.session.models.map((model: { id: string; simulated: boolean }) => [model.id, model.simulated]),
      [
        ["model-a", false],
        ["model-b", false],
      ],
    );
    assert.equal(session.body.session.claudeUsable, false);
    assert.equal(session.body.session.capabilities.claudeWebsiteLogin, "not_configured");
    const missing = await act(origin, sessionId, { type: "select_model", actionId: "missing", modelId: "not-listed" });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error.code, "model_unavailable");
    const selected = await act(origin, sessionId, { type: "select_model", actionId: "pick-a", modelId: "model-a" });
    assert.equal(selected.status, 200);

    const stream = await openSse(`${origin}/sessions/${sessionId}/events`, authHeaders(token));
    await act(origin, sessionId, message("send-1", "req-1", "client-1", "model-a", prompt));
    const done = await stream.waitFor((items) => items.some((item) => item.type === "completed"), 1000);
    assert.equal(
      done
        .filter((item) => item.type === "delta")
        .map((item) => item.delta)
        .join(""),
      "Hello",
    );
    assert.equal(JSON.stringify(done).includes("hidden-thought"), false);
    assert.equal(done.some((item) => item.type === "completed"), true);

    await act(origin, sessionId, message("send-err", "req-err", "client-err", "model-a", "explode"));
    const failed = await stream.waitFor((items) => items.some((item) => item.requestId === "req-err" && item.type === "error"), 1000);
    assert.equal(failed.some((item) => item.requestId === "req-err" && item.type === "completed"), false);
    assert.equal(JSON.stringify(failed).includes(prompt), false);
    assert.equal(JSON.stringify(failed).includes(apiKey), false);

    await act(origin, sessionId, message("send-hold", "req-hold", "client-hold", "model-a", "hold"));
    const busy = await act(origin, sessionId, message("send-busy", "req-busy", "client-busy", "model-a", "hold"));
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, "invalid_state");
    const cancelled = await act(origin, sessionId, { type: "cancel", actionId: "cancel-hold", requestId: "req-hold" });
    assert.equal(cancelled.status, 200);
    const afterCancel = await stream.waitFor(
      (items) => items.some((item) => item.requestId === "req-hold" && item.type === "cancelled"),
      1000,
    );
    assert.equal(afterCancel.some((item) => item.requestId === "req-hold" && item.type === "completed"), false);
    const abortDeadline = Date.now() + 1000;
    while (!aborted && Date.now() < abortDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(aborted, true);
    stream.close();

    const pinnedOrigin = `http://127.0.0.1:${pinnedPort}`;
    const pinnedSession = await create(pinnedOrigin);
    const rejected = await act(pinnedOrigin, pinnedSession, {
      type: "select_model",
      actionId: "pick-a",
      modelId: "model-a",
    });
    assert.equal(rejected.status, 409);
    const allowed = await act(pinnedOrigin, pinnedSession, {
      type: "select_model",
      actionId: "pick-b",
      modelId: "model-b",
    });
    assert.equal(allowed.status, 200);
    assert.equal(audit.join("\n").includes(apiKey), false);
    assert.equal(audit.join("\n").includes(prompt), false);
  } finally {
    await app.close();
    await audited.close();
    upstream.close();
  }
});

function message(actionId: string, requestId: string, clientRequestId: string, modelId: string, text: string) {
  return { type: "send_message", actionId, requestId, clientRequestId, modelId, text };
}

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

async function act(origin: string, sessionId: string, body: Record<string, unknown>) {
  return readJson(
    await fetch(`${origin}/sessions/${sessionId}/actions`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function listen(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}
