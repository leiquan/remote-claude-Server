import assert from "node:assert/strict";
import test from "node:test";
import { authHeaders, openSse, readJson, startGateway } from "./support.ts";

async function authenticatedSession(url: (path: string) => string, token: string) {
  const created = await readJson(
    await fetch(url("/sessions"), {
      method: "POST",
      headers: authHeaders(token, { "content-type": "application/json" }),
      body: "{}",
    }),
  );
  const sessionId = created.body.session.sessionId as string;
  const act = async (body: unknown) =>
    readJson(
      await fetch(url(`/sessions/${sessionId}/actions`), {
        method: "POST",
        headers: authHeaders(token, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      }),
    );
  await act({ type: "login_input", actionId: "s", step: "start" });
  await act({ type: "login_input", actionId: "c", step: "challenge" });
  await act({ type: "login_input", actionId: "v", step: "verification", simulationResult: "authenticated" });
  await act({ type: "select_model", actionId: "m", modelId: "sim.echo" });
  return { sessionId, act };
}

async function waitUntil(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not reached");
}

test("socket destroy cancels only after the last subscriber, and a POST body does not", async () => {
  const gateway = await startGateway({ adapter: "mock", mockSettleMs: 2_000 });
  const token = gateway.token ?? "";
  try {
    const { sessionId, act } = await authenticatedSession(gateway.url, token);
    const first = await openSse(gateway.url(`/sessions/${sessionId}/events`), authHeaders(token));
    const second = await openSse(gateway.url(`/sessions/${sessionId}/events`), authHeaders(token));
    const sent = await act({
      type: "send_message",
      actionId: "send",
      requestId: "req-live",
      clientRequestId: "client-live",
      modelId: "sim.echo",
      text: "keep",
    });
    assert.equal(sent.status, 202);
    assert.deepEqual(sent.body.session.activeRequestIds, ["req-live"]);

    first.close();
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stillThere = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}`), { headers: authHeaders(token) }),
    );
    assert.deepEqual(stillThere.body.session.activeRequestIds, ["req-live"]);

    second.close();
    await waitUntil(async () => {
      const current = await readJson(
        await fetch(gateway.url(`/sessions/${sessionId}`), { headers: authHeaders(token) }),
      );
      return current.body.session.activeRequestIds.length === 0;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const replay = await openSse(gateway.url(`/sessions/${sessionId}/events`), authHeaders(token));
    const events = await replay.waitFor((items) => items.some((item) => item.type === "cancelled"), 1000);
    const disconnects = events.filter((item) => item.type === "cancelled" && item.cause === "subscriber_disconnect");
    assert.equal(disconnects.length, 1);
    assert.deepEqual(disconnects[0]?.stop, {
      localForwarding: "stopped",
      page: "not_attempted",
      upstream: "not_applicable",
    });
    assert.equal(events.some((item) => item.type === "completed"), false);
    replay.close();
  } finally {
    await gateway.close();
  }
});

test("explicit cancel and delete do not emit completed", async () => {
  const gateway = await startGateway({ adapter: "mock", mockSettleMs: 2_000 });
  const token = gateway.token ?? "";
  try {
    const { sessionId, act } = await authenticatedSession(gateway.url, token);
    const stream = await openSse(gateway.url(`/sessions/${sessionId}/events`), authHeaders(token));
    await act({
      type: "send_message",
      actionId: "send-a",
      requestId: "req-a",
      clientRequestId: "client-a",
      modelId: "sim.echo",
      text: "cancel-me",
    });
    const cancelled = await act({ type: "cancel", actionId: "cancel-a", requestId: "req-a" });
    assert.equal(cancelled.status, 200);
    const events = await stream.waitFor((items) => items.some((item) => item.cause === "client_cancel"), 1000);
    assert.equal(events.some((item) => item.type === "completed"), false);
    stream.close();

    const again = await openSse(gateway.url(`/sessions/${sessionId}/events`), authHeaders(token));
    await act({
      type: "send_message",
      actionId: "send-b",
      requestId: "req-b",
      clientRequestId: "client-b",
      modelId: "sim.echo",
      text: "delete-me",
    });
    const removed = await fetch(gateway.url(`/sessions/${sessionId}`), {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(removed.status, 204);
    const seen = await again.waitFor((items) => items.some((item) => item.cause === "session_deleted"), 1000);
    assert.equal(seen.some((item) => item.type === "completed"), false);
    again.close();
    const gone = await readJson(await fetch(gateway.url(`/sessions/${sessionId}`), { headers: authHeaders(token) }));
    assert.equal(gone.status, 404);
  } finally {
    await gateway.close();
  }
});
