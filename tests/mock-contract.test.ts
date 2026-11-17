import assert from "node:assert/strict";
import test from "node:test";
import { authHeaders, openSse, readJson, startGateway } from "./support.ts";

async function createSession(url: (path: string) => string, token: string) {
  const created = await readJson(
    await fetch(url("/sessions"), {
      method: "POST",
      headers: authHeaders(token, { "content-type": "application/json" }),
      body: "{}",
    }),
  );
  assert.equal(created.status, 201);
  return created.body.session as {
    sessionId: string;
    login: { state: string; simulated: boolean; allowedActions: string[] };
    models: Array<{ id: string; available: boolean; simulated: boolean; displayName: string }>;
  };
}

async function act(url: (path: string) => string, token: string, sessionId: string, body: unknown) {
  return readJson(
    await fetch(url(`/sessions/${sessionId}/actions`), {
      method: "POST",
      headers: authHeaders(token, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    }),
  );
}

test("mock login is simulated, labeled, and still not Claude", async () => {
  const gateway = await startGateway({ adapter: "mock", mockSettleMs: 200 });
  try {
    const health = await readJson(await fetch(gateway.url("/health")));
    assert.equal(health.body.claudeUsable, false);
    assert.equal(health.body.adapter, "mock");
    assert.equal(health.body.capabilities.claudeWebsiteLogin, "simulated");
    assert.equal(health.body.capabilities.liveConversation, "simulated");

    const session = await createSession(gateway.url, gateway.token ?? "");
    assert.equal(session.models[0].id, "sim.echo");
    assert.equal(session.models[0].available, false);
    assert.equal(session.models[0].simulated, true);
    assert.match(session.models[0].displayName, /not Claude/);

    const sessionId = session.sessionId;
    const started = await act(gateway.url, gateway.token ?? "", sessionId, {
      type: "login_input",
      actionId: "start-1",
      step: "start",
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.session.login.state, "authenticating");
    assert.equal(started.body.session.login.simulated, true);
    assert.equal(started.body.session.claudeUsable, false);

    const challenged = await act(gateway.url, gateway.token ?? "", sessionId, {
      type: "login_input",
      actionId: "challenge-1",
      step: "challenge",
    });
    assert.equal(challenged.body.session.login.state, "verification_required");

    const skipped = await act(gateway.url, gateway.token ?? "", sessionId, {
      type: "login_input",
      actionId: "bad-step",
      step: "start",
    });
    assert.equal(skipped.status, 409);
    assert.equal(skipped.body.error.code, "invalid_state");

    const authenticated = await act(gateway.url, gateway.token ?? "", sessionId, {
      type: "login_input",
      actionId: "verify-1",
      step: "verification",
      simulationResult: "authenticated",
    });
    assert.equal(authenticated.body.status, "accepted");
    assert.equal(authenticated.body.session.login.state, "authenticated");
    assert.equal(authenticated.body.session.login.simulated, true);
    assert.equal(authenticated.body.session.models[0].available, true);
    assert.equal(authenticated.body.session.claudeUsable, false);

    const selected = await act(gateway.url, gateway.token ?? "", sessionId, {
      type: "select_model",
      actionId: "model-1",
      modelId: "sim.echo",
    });
    assert.equal(selected.status, 200);
    assert.equal(selected.body.session.selectedModelId, "sim.echo");
  } finally {
    await gateway.close();
  }
});

test("duplicate submissions, cancellation, and disconnect stay on one generation", async () => {
  const gateway = await startGateway({ adapter: "mock", mockSettleMs: 2_000 });
  const token = gateway.token ?? "";
  try {
    const session = await createSession(gateway.url, token);
    const sessionId = session.sessionId;
    await act(gateway.url, token, sessionId, { type: "login_input", actionId: "s", step: "start" });
    await act(gateway.url, token, sessionId, { type: "login_input", actionId: "c", step: "challenge" });
    const failed = await act(gateway.url, token, sessionId, {
      type: "login_input",
      actionId: "f",
      step: "verification",
      simulationResult: "failed",
    });
    assert.equal(failed.body.session.login.state, "failed");
    await act(gateway.url, token, sessionId, { type: "login_input", actionId: "s2", step: "start" });
    await act(gateway.url, token, sessionId, { type: "login_input", actionId: "c2", step: "challenge" });
    await act(gateway.url, token, sessionId, {
      type: "login_input",
      actionId: "ok",
      step: "verification",
      simulationResult: "authenticated",
    });
    await act(gateway.url, token, sessionId, {
      type: "select_model",
      actionId: "model",
      modelId: "sim.echo",
    });

    const stream = await openSse(gateway.url(`/sessions/${sessionId}/events`), authHeaders(token));
    const payload = {
      type: "send_message",
      actionId: "send-1",
      requestId: "req-1",
      clientRequestId: "client-1",
      modelId: "sim.echo",
      text: "echo-me",
    };
    const sent = await act(gateway.url, token, sessionId, payload);
    assert.equal(sent.status, 202);
    assert.equal(sent.body.status, "accepted");
    assert.equal(sent.body.requestId, "req-1");
    assert.equal(sent.body.session.conversation.clientRequestId, "client-1");
    assert.equal(sent.body.session.conversation.text, "echo-me");
    assert.equal(sent.body.session.conversation.modelId, "sim.echo");
    assert.ok(sent.body.session.activeRequestIds.includes("req-1"));

    const reordered = await act(gateway.url, token, sessionId, {
      text: "echo-me",
      modelId: "sim.echo",
      clientRequestId: "client-1",
      requestId: "req-1",
      actionId: "send-1",
      type: "send_message",
    });
    assert.equal(reordered.status, 202);
    assert.equal(reordered.body.status, "duplicate");
    assert.equal(reordered.body.originalStatus, "accepted");
    assert.equal(reordered.body.originalActionId, "send-1");

    const conflict = await act(gateway.url, token, sessionId, { ...payload, text: "different" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "action_id_conflict");

    const sameClient = await act(gateway.url, token, sessionId, {
      ...payload,
      actionId: "send-2",
    });
    assert.equal(sameClient.body.status, "duplicate");
    assert.equal(sameClient.body.requestId, "req-1");
    assert.equal(sameClient.body.originalActionId, "send-1");

    const differentClient = await act(gateway.url, token, sessionId, {
      ...payload,
      actionId: "send-3",
      requestId: "req-3",
      text: "other",
    });
    assert.equal(differentClient.status, 409);
    assert.equal(differentClient.body.error.code, "client_request_conflict");

    const cancelled = await act(gateway.url, token, sessionId, {
      type: "cancel",
      actionId: "cancel-1",
      requestId: "req-1",
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "accepted");
    const events = await stream.waitFor((items) => items.some((item) => item.type === "cancelled"), 1000);
    assert.equal(events.some((item) => item.type === "completed"), false);
    const cancelEvent = events.find((item) => item.type === "cancelled");
    assert.equal(cancelEvent?.requestId, "req-1");
    assert.equal(cancelEvent?.actionId, "cancel-1");
    assert.equal(cancelEvent?.sourceActionId, "send-1");
    assert.equal(cancelEvent?.simulated, true);
    assert.deepEqual(cancelEvent?.stop, {
      localForwarding: "stopped",
      page: "not_attempted",
      upstream: "not_applicable",
    });
    assert.equal(events.filter((item) => item.type === "delta").length, 2);

    const secondCancel = await act(gateway.url, token, sessionId, {
      type: "cancel",
      actionId: "cancel-2",
      requestId: "req-1",
    });
    assert.equal(secondCancel.status, 409);
    assert.equal(secondCancel.body.error.code, "not_cancellable");
    stream.close();

    const replay = await openSse(gateway.url(`/sessions/${sessionId}/events`), {
      ...authHeaders(token),
      "last-event-id": String(events[0].eventId),
    });
    assert.equal(replay.status, 200);
    assert.match(replay.contentType, /text\/event-stream/);
    const replayed = await replay.waitFor((items) => items.length >= events.length - 1, 1000);
    assert.equal(replayed[0].eventId, events[1].eventId);
    assert.equal(replayed.some((item) => item.type === "completed"), false);
    replay.close();

    const missingCursor = await openSse(gateway.url(`/sessions/${sessionId}/events`), {
      ...authHeaders(token),
      "last-event-id": "evt_missing",
    });
    assert.equal(missingCursor.status, 409);
    assert.match(missingCursor.text, /event_cursor_invalid/);
    assert.match(missingCursor.text, /Resync is required/);
    assert.match(missingCursor.text, /will not resume a send/);
    missingCursor.close();

    const removed = await fetch(gateway.url(`/sessions/${sessionId}`), {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(removed.status, 204);
    const removedAgain = await fetch(gateway.url(`/sessions/${sessionId}`), {
      method: "DELETE",
      headers: authHeaders(token),
    });
    assert.equal(removedAgain.status, 204);
    const gone = await readJson(
      await fetch(gateway.url(`/sessions/${sessionId}`), { headers: authHeaders(token) }),
    );
    assert.equal(gone.status, 404);
  } finally {
    await gateway.close();
  }
});

test("last event-stream disconnect cancels generation and stays on the same session", async () => {
  const gateway = await startGateway({ adapter: "mock", mockSettleMs: 2_000 });
  const token = gateway.token ?? "";
  try {
    const session = await createSession(gateway.url, token);
    const sessionId = session.sessionId;
    await act(gateway.url, token, sessionId, { type: "login_input", actionId: "s", step: "start" });
    await act(gateway.url, token, sessionId, { type: "login_input", actionId: "c", step: "challenge" });
    await act(gateway.url, token, sessionId, {
      type: "login_input",
      actionId: "v",
      step: "verification",
      simulationResult: "expired",
    });
    assert.equal(
      (await act(gateway.url, token, sessionId, { type: "login_input", actionId: "s2", step: "start" })).body.session
        .login.state,
      "authenticating",
    );
    await act(gateway.url, token, sessionId, { type: "login_input", actionId: "c2", step: "challenge" });
    await act(gateway.url, token, sessionId, {
      type: "login_input",
      actionId: "v2",
      step: "verification",
      simulationResult: "authenticated",
    });
    await act(gateway.url, token, sessionId, { type: "select_model", actionId: "m", modelId: "sim.echo" });

    const first = await openSse(gateway.url(`/sessions/${sessionId}/events`), authHeaders(token));
    await act(gateway.url, token, sessionId, {
      type: "send_message",
      actionId: "send",
      requestId: "req",
      clientRequestId: "client",
      modelId: "sim.echo",
      text: "stay",
    });
    const started = await first.waitFor((items) => items.some((item) => item.type === "delta"), 1000);
    const cursor = String(started[0].eventId);
    first.close();
    let during = await readJson(await fetch(gateway.url(`/sessions/${sessionId}`), { headers: authHeaders(token) }));
    for (let attempt = 0; attempt < 20 && during.body.session.activeRequestIds.length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      during = await readJson(await fetch(gateway.url(`/sessions/${sessionId}`), { headers: authHeaders(token) }));
    }
    assert.equal(during.body.session.sessionId, sessionId);
    assert.deepEqual(during.body.session.activeRequestIds, []);
    const resumed = await openSse(gateway.url(`/sessions/${sessionId}/events`), {
      ...authHeaders(token),
      "last-event-id": cursor,
    });
    const rest = await resumed.waitFor((items) => items.some((item) => item.type === "cancelled"), 1000);
    assert.equal(rest.some((item) => item.type === "cancelled" && item.cause === "subscriber_disconnect"), true);
    assert.equal(rest.some((item) => item.type === "completed"), false);
    resumed.close();
    assert.equal(JSON.stringify(gateway.audit).includes("stay"), false);
  } finally {
    await gateway.close();
  }
});
