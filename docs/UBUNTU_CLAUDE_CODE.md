# Ubuntu Claude Code CLI bridge (work in progress)

This branch introduces a **local CLI runner only**. It is not wired into the existing gateway routes yet. No iOS-to-Claude end-to-end functionality is claimed.

## Target architecture

iOS SwiftUI client -> operator-managed HTTPS reverse proxy -> Node.js gateway on Ubuntu (loopback) -> locally installed Claude Code CLI.

The CLI runs under a dedicated, unprivileged Ubuntu user in a preconfigured absolute working directory. The phone never supplies an executable path, working directory, shell command, or raw CLI arguments. The gateway must authenticate every request and bind CLI sessions to its own authorized session identity before invoking this module.

## Prerequisites on the Ubuntu host

- Node.js 22+ for the existing gateway.
- Claude Code installed using the current official instructions at https://code.claude.com/docs/en/setup .
- Authenticate Claude Code interactively **on the Ubuntu host**, as the same unprivileged user that runs the gateway. Never upload credentials, cookies, or token files to GitHub.
- A dedicated workspace directory with least-privilege permissions.
- HTTPS termination with a trusted certificate in front of the gateway; never expose the loopback HTTP port directly.

## Current runner behavior

`runClaudeTurn(prompt, { cwd, executable?, timeoutMs?, maxOutputBytes?, signal?, resumeSessionId? })` invokes Claude Code with `-p --output-format json --permission-mode plan`, without a shell. The runner limits time and stdout bytes, supports cancellation and validates optional CLI resume IDs. Stderr is deliberately not returned to the caller.

**Plan mode is read-only planning, not unattended code editing.** This is intentional for the first remote execution milestone. A separate, explicit approval design is needed before allowing file modifications or commands.

## Remaining integration work

1. Add an explicit `cli` adapter to gateway configuration, health capabilities, and action handling; do not falsely mark live Claude usable until a real host check succeeds.
2. Bind gateway session IDs to Claude CLI session IDs server-side, persist this mapping safely, and serialize concurrent sends to one Claude session.
3. Stream parsed CLI events over the existing authenticated SSE contract, with bounded buffers and cancellation semantics; never misrepresent gateway disconnect as confirmed upstream cancellation.
4. Add Ubuntu service deployment (systemd, dedicated user, environment file, HTTPS proxy) and security checks.
5. Add integration tests using a fake CLI binary, then validate on an actual Ubuntu host with Claude Code installed and authenticated; test iOS separately.

## Verification

The tests in `tests/claude-cli.test.ts` use a fake executable; they do **not** prove real Claude Code execution. This environment has not run the repository test suite or Ubuntu end-to-end checks.
