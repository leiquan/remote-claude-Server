import { BrowserHost } from "./browser/host.ts";
import { parseAllowlist } from "./browser/allowlist.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createGatewayApp } from "./http.ts";
import { SERVICE_ID } from "./types.ts";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  const message = error instanceof ConfigError ? error.message : "Gateway configuration was rejected.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let browserHost: BrowserHost | null = null;
if (config.browserHostEnabled) {
  try {
    browserHost = await BrowserHost.launch({
      executable: process.env.BROWSER_EXECUTABLE?.trim() || "google-chrome",
      allowlist: parseAllowlist(process.env.BROWSER_ALLOWLIST),
      headless: process.env.BROWSER_HEADLESS === "1",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Browser host failed to start.";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

const app = createGatewayApp({
  adapter: config.adapter,
  token: config.token.token,
  basePath: config.basePath,
  mockSettleMs: config.mockSettleMs,
  browserHostRunning: browserHost !== null,
  browserHost,
  audit(record) {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  },
});

const stop = async () => {
  await app.close();
};
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});

try {
  const port = await app.listen(config.port, config.host);
  process.stdout.write(
    `${JSON.stringify({
      serviceId: SERVICE_ID,
      listening: `http://${config.host}:${port}${config.basePath}`,
      adapter: config.adapter,
      claudeUsable: false,
      gatewayTokenConfigured: config.token.token !== null,
    })}\n`,
  );
} catch {
  process.stderr.write("Gateway failed to listen.\n");
  process.exit(1);
}
