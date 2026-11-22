# Private Web Client (Ubuntu)

The first web client lives in `web/index.html`. It uses the existing gateway v0 contract, without altering the iOS application or gateway routes.

## Development / local verification

Run the existing gateway on loopback using the repository README instructions. Serve `web/` with a static web server. In development, configure the static server to reverse-proxy `/gateway/*` to `http://127.0.0.1:43123/*` (remove the `/gateway` prefix). Enter `https://your-private-domain/gateway` as the base URL in the page. The current gateway does not provide browser CORS headers, so serving the web page from another origin will not work; use the same HTTPS origin and a reverse proxy.

**Do not publish this page without HTTPS and access controls.** The gateway Bearer token is entered manually and stays in page memory; it is not stored in localStorage or cookies. Browser extensions, compromised scripts, and anyone with access to an unlocked browser can still read it. Use a dedicated private hostname, network access restriction (VPN or equivalent), and security-reviewed proxy configuration.

## Current limitations

- The v0 gateway's `claudeUsable` field is always false. The web client correctly disables message submission until a future real adapter reports `claudeUsable: true` and `liveConversation: supported`.
- No working Claude Code CLI integration is included in this branch. See the separate draft PR for the initial CLI runner.
- The current gateway has no GET list of past sessions and stores sessions only in memory. The page creates a new session when connecting.
- No file uploads, PDF handling, durable chat history, or real model discovery.
- Event streaming uses authenticated fetch rather than EventSource so that the Bearer token stays in the Authorization header.
- The web client currently does not implement automatic reconnection or comprehensive handling of stale event cursors. Reconnect manually.
- **Tests have not been run against an Ubuntu host.** Do not claim production readiness.

## Acceptance criteria for the next phase

1. HTTPS same-origin deployment with a private authentication boundary.
2. Real Claude Code CLI adapter, model selection limited to available account models, and honest capability reporting.
3. Real SSE events, cancellation, reconnection, and durable server-side sessions.
4. Automated browser checks and Ubuntu end-to-end tests using a dedicated non-root user.
