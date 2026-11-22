import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Gateway, type GatewayResponse } from "../server/src/gateway.ts";
import type { StreamEvent } from "../server/src/types.ts";

async function status(response: Promise<GatewayResponse>): Promise<number> {
  const value = await response;
  assert.ok(value.kind !== "stream");
  return value.httpStatus;
}

test("CLI gateway selects models, streams before exit, resumes, and cancels", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "remote-claude-gateway-"));
  const executable = join(cwd, "claude");
  const nativeId = "12345678-1234-1234-1234-123456789abc";
  const gateway = new Gateway({
    adapter: "cli", token: "test-token-for-cli-gateway", cli: { cwd, executable, models: ["sonnet", "opus"] },
  });
  try {
    await writeFile(executable, `#!${process.execPath}
const argv = process.argv.slice(2);
const option = key => argv[argv.indexOf(key) + 1];
const prompt = argv.at(-1);
if (option("--output-format") !== "stream-json" || option("--tools") !== "") process.exit(2);
if (prompt === "first" && (option("--model") !== "sonnet" || argv.includes("--resume"))) process.exit(3);
if (prompt === "second" && (option("--model") !== "opus" || option("--resume") !== "${nativeId}" || !argv.includes("--fork-session"))) process.exit(4);
const emit = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
emit({type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text:"你"}}});
setTimeout(() => {
  emit({type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text:"好"}}});
  emit({type:"result", result:"你好", session_id:"${nativeId}"});
}, prompt === "cancel" ? 30000 : 150);
`, { mode: 0o700 });
    const created = await gateway.createSession();
    assert.equal(created.kind, "json");
    const { session } = created.body as { session: { sessionId: string; claudeUsable: boolean } };
    assert.equal(session.claudeUsable, false);
    const id = session.sessionId;
    const opened = gateway.openEvents(id, undefined);
    assert.equal(opened.kind, "stream");
    const events: StreamEvent[] = [];
    let notify: (() => void) | undefined;
    const unsubscribe = opened.replayAndSubscribe({ send(event) { events.push(event); notify?.(); }, close() {} });
    async function waitFor(requestId: string, type: StreamEvent["type"]) {
      const matches = (event: StreamEvent) => event.requestId === requestId && event.type === type;
      const existing = events.find(matches);
      if (existing) return existing;
      return new Promise<StreamEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Missing ${requestId} ${type}: ${JSON.stringify(events)}`)), 3000);
        notify = () => {
          const found = events.find(matches);
          if (!found) return;
          clearTimeout(timer);
          notify = undefined;
          resolve(found);
        };
      });
    }
    const select = (modelId: string) => gateway.performAction(id, { type: "select_model", actionId: "select-" + modelId, modelId });
    const send = (text: string, modelId: string) => gateway.performAction(id, {
      type: "send_message", actionId: "action-" + text, requestId: text,
      clientRequestId: "client-" + text, text, modelId,
    });
    assert.equal(await status(select("unknown")), 409);
    assert.equal(await status(select("sonnet")), 200);
    assert.equal(await status(send("first", "sonnet")), 202);
    assert.equal((await waitFor("first", "delta")).type, "delta");
    assert.equal(events.some(event => event.type === "completed"), false);
    assert.equal(await status(send("busy", "sonnet")), 409);
    await waitFor("first", "completed");
    assert.equal(await status(select("opus")), 200);
    assert.equal(await status(send("second", "opus")), 202);
    await waitFor("second", "completed");
    const snapshot = gateway.getSession(id);
    assert.equal(snapshot.kind, "json");
    assert.deepEqual((snapshot.body as { history: { text: string }[] }).history.map(message => message.text),
      ["first", "你好", "second", "你好"]);
    assert.equal(JSON.stringify(snapshot.body).includes(nativeId), false);
    assert.equal(await status(send("cancel", "opus")), 202);
    await waitFor("cancel", "delta");
    assert.equal(await status(gateway.performAction(id, { type: "cancel", actionId: "stop", requestId: "cancel" })), 200);
    await waitFor("cancel", "cancelled");
    assert.equal(events.some(event => event.type === "completed" && event.requestId === "cancel"), false);
    unsubscribe();
    assert.equal(await status(gateway.deleteSession(id)), 204);
    const listed = gateway.listSessions();
    assert.equal(listed.kind, "json");
    assert.deepEqual(listed.body, { sessions: [] });
  } finally {
    await gateway.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});
