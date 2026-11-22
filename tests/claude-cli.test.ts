import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runClaudeTurn } from "../server/src/claude-cli.ts";

test("Claude CLI bridge parses a successful response without a real account", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remote-claude-cli-"));
  const executable = path.join(dir, "fake-claude");
  try {
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' '{\"result\":\"hello\",\"session_id\":\"abc\"}'\n", { mode: 0o700 });
    const result = await runClaudeTurn("hello", { cwd: dir, executable });
    assert.deepEqual(result, { text: "hello", sessionId: "abc" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude CLI bridge rejects already-aborted requests", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runClaudeTurn("hello", { cwd: "/tmp", signal: controller.signal }), { code: "cancelled" });
});

test("Claude CLI bridge rejects empty prompts and relative working directories", async () => {
  await assert.rejects(runClaudeTurn(" ", { cwd: "/tmp" }), TypeError);
  await assert.rejects(runClaudeTurn("hello", { cwd: "." }), TypeError);
});
