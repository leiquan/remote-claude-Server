import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);

function run(script: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync("sh", [new URL(script, root).pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("preflight never prints the gateway token and is not deploy-ready", () => {
  const secret = "preflight-secret-token-value";
  const ok = run("deploy/preflight.sh", [], { GATEWAY_ACCESS_TOKEN: secret, GATEWAY_PORT: "43123" });
  assert.equal(ok.stdout.includes(secret), false);
  assert.match(ok.stdout, /deploy_ready=false/);
  assert.match(ok.stdout, /GATEWAY_ACCESS_TOKEN=present/);
  assert.match(ok.stdout, /node_runtime=v/);
  assert.equal(ok.status, 0);
  const bad = run("deploy/preflight.sh", [], { BROWSER_EXECUTABLE: "/bin/false", GATEWAY_ACCESS_TOKEN: secret });
  assert.equal(bad.stdout.includes(secret), false);
  assert.match(bad.stdout, /browser_executable=unusable/);
  assert.notEqual(bad.status, 0);
});

test("version switch and first-install removal stay inside a temp root", () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-claude-release-"));
  writeFileSync(join(dir, "RELEASE_ROOT_OK"), "ok\n");
  mkdirSync(join(dir, "releases", "1.0.0"), { recursive: true });
  mkdirSync(join(dir, "releases", "1.0.1"), { recursive: true });
  writeFileSync(join(dir, "releases", "1.0.0", "VERSION"), "1.0.0\n");
  writeFileSync(join(dir, "releases", "1.0.1", "VERSION"), "1.0.1\n");

  const first = run("deploy/switch-release.sh", [dir, "1.0.0"]);
  assert.equal(first.status, 0);
  assert.equal(readlinkSync(join(dir, "current")), "releases/1.0.0");
  assert.equal(existsSync(join(dir, "previous")), false);

  const removed = run("deploy/remove-first-install.sh", [dir]);
  assert.equal(removed.status, 0);
  assert.equal(existsSync(join(dir, "current")), false);
  assert.equal(existsSync(join(dir, "releases", "1.0.0", "VERSION")), true);

  assert.equal(run("deploy/switch-release.sh", [dir, "1.0.0"]).status, 0);
  const second = run("deploy/switch-release.sh", [dir, "1.0.1"]);
  assert.equal(second.status, 0);
  assert.equal(readlinkSync(join(dir, "current")), "releases/1.0.1");
  assert.equal(readlinkSync(join(dir, "previous")), "releases/1.0.0");

  const blocked = run("deploy/remove-first-install.sh", [dir]);
  assert.equal(blocked.status, 2);
  assert.equal(readlinkSync(join(dir, "current")), "releases/1.0.1");

  const rolled = run("deploy/rollback-release.sh", [dir]);
  assert.equal(rolled.status, 0);
  assert.equal(readlinkSync(join(dir, "current")), "releases/1.0.0");
  assert.equal(readlinkSync(join(dir, "previous")), "releases/1.0.1");

  const refused = run("deploy/switch-release.sh", ["/etc", "1.0.0"]);
  assert.equal(refused.status, 1);
});
