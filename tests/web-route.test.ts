import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { createGatewayApp } from "../server/src/http.ts";

test("private web page and session listing use the same gateway prefix", async () => {
  const token = "private-web-test-gateway-token";
  const app = createGatewayApp({ adapter: "unconfigured", token, basePath: "/gateway" });

  function get(url: string, headers: IncomingHttpHeaders = {}) {
    return new Promise<{ status: number; body: string; headers: Record<string, string> }>(resolve => {
      let status = 0;
      let responseHeaders: Record<string, string> = {};
      app.server.emit("request", { method: "GET", url, headers }, {
        setHeader() {},
        writeHead(code: number, fields: Record<string, string>) {
          status = code;
          responseHeaders = fields;
        },
        end(payload: Buffer | string) {
          resolve({ status, headers: responseHeaders, body: payload.toString() });
        },
      });
    });
  }

  try {
    const page = await get("/gateway/web");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.headers["content-security-policy"], /connect-src 'self'/);
    assert.match(page.body, /Remote Claude/);
    assert.equal((await get("/web")).status, 404);
    assert.equal((await get("/gateway/sessions")).status, 401);
    assert.equal((await get("/gateway/sessions", { authorization: "Bearer incorrect" })).status, 401);
    const authorized = await get("/gateway/sessions", { authorization: "Bearer " + token });
    assert.equal(authorized.status, 200);
    assert.deepEqual(JSON.parse(authorized.body), { sessions: [] });
  } finally {
    await app.close();
  }
});
