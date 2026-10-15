import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import { installHttpSecurity, publicOrigin, requestOrigin, trustedProxies, validateJsonShape, safeApiError, createStreamLimiter } from "../http-security";

const ORIGIN = "https://restaurant.example";

async function harness(options: { production?: boolean; proxyCidrs?: string } = {}) {
  const app = express();
  const production = options.production ?? true;
  installHttpSecurity(app, { origin: ORIGIN, production, proxyCidrs: options.proxyCidrs });
  app.use(express.json({ limit: "128kb", inflate: false }));
  app.use(validateJsonShape);
  app.get("/api/ping", (req, res) => res.json({ origin: requestOrigin(req, ORIGIN, production), ip: req.ip }));
  for (const route of ["/api/echo", "/api/chapa/initialize", "/api/chapa/webhook", "/api/shipday/webhook"]) {
    app.post(route, (_req, res) => res.json({ accepted: true }));
  }
  app.get("/__/auth/handler", (_req, res) => res.send("<html><body>Official authentication helper placeholder</body></html>"));
  app.get("/api/throw", (_req, _res, next) => next(Object.assign(new Error("PRIVATE_TOKEN_CUSTOMER_ADDRESS /host/secret.env"), { detail: "PRIVATE_PROVIDER_BODY" })));
  app.use(safeApiError);
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    app, base,
    async request(path: string, options: RequestInit = {}) { return fetch(base + path, options); },
    async post(path: string, body: any = {}, headers: Record<string, string> = {}) {
      return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

test("public origins are canonical and production requires explicit HTTPS", () => {
  assert.equal(publicOrigin("https://restaurant.example:443/", true), ORIGIN);
  assert.equal(publicOrigin("http://localhost:3000/", false), "http://localhost:3000");
  assert.equal(publicOrigin("", false), "http://localhost:3000");
  for (const input of ["", "http://restaurant.example", "https://user:password@restaurant.example", "https://restaurant.example/path", "https://restaurant.example/?q=x", "https://restaurant.example/#x", "javascript:alert(1)", "//restaurant.example"]) {
    assert.throws(() => publicOrigin(input, true));
  }
  assert.throws(() => publicOrigin("private-configuration-without-a-protocol", true), (error: any) =>
    /APP_URL.*protocol/.test(error.message) && !error.message.includes("private-configuration"));
});

test("payment and redirect origins ignore forged Host and Forwarded headers", () => {
  for (const host of ["evil.example", "localhost:3000", "127.0.0.1:4000"]) {
    assert.equal(requestOrigin({ headers: { host, "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", forwarded: "host=evil.example;proto=http" } }, ORIGIN, true), ORIGIN);
  }
  assert.equal(requestOrigin({ headers: { host: "evil.example", "x-forwarded-host": "localhost:3000" } }, ORIGIN, false), ORIGIN);
  assert.equal(requestOrigin({ headers: { host: "localhost:3000", "x-forwarded-host": "evil.example" } }, ORIGIN, false), "http://localhost:3000");
  assert.equal(requestOrigin({ headers: { host: "127.0.0.1:3001" } }, ORIGIN, false), "http://127.0.0.1:3001");
  assert.equal(requestOrigin({ headers: { host: "[::1]:3000" } }, ORIGIN, false), "http://[::1]:3000");
  assert.equal(requestOrigin({ headers: { host: "localhost:99999" } }, ORIGIN, false), ORIGIN);
});

test("proxy trust is opt-in and rejects broad trust, hop counts, and malformed ranges", () => {
  assert.equal(trustedProxies(), false);
  assert.equal(trustedProxies("   "), false);
  assert.deepEqual(trustedProxies("loopback, 172.18.0.0/16, 192.0.2.5, 2001:db8::/64"), ["loopback", "172.18.0.0/16", "192.0.2.5", "2001:db8::/64"]);
  for (const value of ["true", "1", "false", "*", "0.0.0.0/0", "::/0", "::/16", "192.0.2.1/33", "2001:db8::/129", "192.0.2.1/bad", "192.0.2.1/24/extra", "loopback,"]) {
    assert.throws(() => trustedProxies(value), /TRUST_PROXY_CIDRS/);
  }
});

test("untrusted forwarded client IP cannot change the effective request identity", async () => {
  const h = await harness();
  try {
    assert.equal(h.app.get("trust proxy"), false);
    // Finish the limiter's startup checks before sending the intentionally
    // spoofed proxy header; effective identity must still ignore that header.
    const baseline = await h.request("/api/ping");
    await baseline.body?.cancel();
    const response = await h.request("/api/ping", { headers: { "x-forwarded-for": "192.0.2.123", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.origin, ORIGIN);
    assert.equal(body.ip, "127.0.0.1");
  } finally { await h.close(); }
});

test("only an explicitly trusted proxy source can supply the client IP", async () => {
  for (const [proxyCidrs, expectedIp] of [["192.0.2.10", "127.0.0.1"], ["loopback", "192.0.2.123"]]) {
    const h = await harness({ proxyCidrs });
    try {
      assert.equal(h.app.get("query parser"), "simple");
      const response = await h.request("/api/ping", { headers: { "x-forwarded-for": "192.0.2.123", "x-forwarded-host": "evil.example" } });
      const body = await response.json() as any;
      assert.equal(body.ip, expectedIp);
      assert.equal(body.origin, ORIGIN);
    } finally { await h.close(); }
  }
});

test("production headers harden content while preserving Google OAuth popup compatibility", async () => {
  const h = await harness();
  try {
    const response = await h.request("/api/ping");
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
    assert.match(response.headers.get("strict-transport-security") || "", /max-age=31536000/);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(self)");
    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.match(csp, /https:\/\/apis\.google\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/\*\.firebaseapp\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/accounts\.google\.com/);
    assert.match(csp, /script-src[^;]*https:\/\/maps\.googleapis\.com/);
    assert.doesNotMatch(csp.match(/script-src [^;]*/)?.[0] || "", /'unsafe-inline'|'unsafe-eval'/);
    const helper = await h.request("/__/auth/handler");
    assert.equal(helper.status, 200);
    assert.equal(helper.headers.get("content-security-policy"), null);
    assert.equal(helper.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
    assert.match(helper.headers.get("cache-control") || "", /no-store/);
  } finally { await h.close(); }
});

test("development headers do not force localhost HTTPS or block Vite scripts", async () => {
  const h = await harness({ production: false });
  try {
    const response = await h.request("/api/ping");
    assert.equal(response.headers.get("strict-transport-security"), null);
    assert.equal(response.headers.get("content-security-policy"), null);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  } finally { await h.close(); }
});

test("cross-site API mutations are blocked without trusting forwarded origin headers", async () => {
  const h = await harness();
  try {
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" }, { origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }]) {
      const response = await h.post("/api/echo", {}, headers);
      assert.equal(response.status, 403);
      assert.equal((await response.json() as any).code, "ORIGIN_FORBIDDEN");
    }
    assert.equal((await h.post("/api/echo", {}, { origin: ORIGIN, "sec-fetch-site": "same-origin" })).status, 200);
    assert.equal((await h.post("/api/echo")).status, 200);
    // Provider webhooks have separate signature/authentication controls and
    // cannot depend on browser-only Origin or Fetch Metadata headers.
    for (const route of ["/api/chapa/webhook", "/api/shipday/webhook"]) {
      assert.equal((await h.post(route, {}, { origin: "https://provider.example", "sec-fetch-site": "cross-site" })).status, 200);
    }
  } finally { await h.close(); }
});

test("JSON prototype keys, deep structures, huge arrays, and non-finite numbers are rejected", async () => {
  const h = await harness();
  try {
    let nested: any = "value";
    for (let index = 0; index < 26; index++) nested = { child: nested };
    for (const body of [JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: { prototype: { polluted: true } } }, { "profile.__proto__.polluted": true }, { nested }, { values: Array(10_001).fill(0) }, []]) {
      const response = await h.post("/api/echo", body);
      assert.equal(response.status, 400);
      assert.equal((await response.json() as any).code, "INVALID_REQUEST_BODY");
    }
    const response = await h.request("/api/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"amount":1e400}' });
    assert.equal(response.status, 400);
    assert.equal((Object.prototype as any).polluted, undefined);
    assert.equal((await h.post("/api/echo", { fields: [1, "valid", null, { nested: true }] })).status, 200);
  } finally { await h.close(); }
});

test("JSON aggregate node budget rejects wide structures before route handling", () => {
  const body = { records: Array.from({ length: 10_000 }, () => ({ a: 1, b: 2, c: 3, d: 4 })) };
  let status = 0;
  let payload: any;
  let reached = false;
  const res: any = { status(value: number) { status = value; return this; }, json(value: any) { payload = value; return this; } };
  validateJsonShape({ path: "/api/echo", body } as any, res, () => { reached = true; });
  assert.equal(status, 400);
  assert.equal(payload.code, "INVALID_REQUEST_BODY");
  assert.equal(reached, false);
});

test("errors, malformed JSON, unsupported compression, and oversized bodies never expose private details", async () => {
  const h = await harness();
  try {
    const internal = await h.request("/api/throw");
    assert.equal(internal.status, 500);
    assert.deepEqual(await internal.json(), { success: false, code: "INTERNAL_ERROR", error: "The request could not be completed." });
    const invalid = await h.request("/api/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"PRIVATE_TOKEN_CUSTOMER_ADDRESS":' });
    assert.equal(invalid.status, 400);
    const invalidText = await invalid.text();
    assert.doesNotMatch(invalidText, /PRIVATE_TOKEN|stack|SyntaxError|secret\.env/);
    assert.equal(JSON.parse(invalidText).code, "INVALID_REQUEST_BODY");
    const large = await h.post("/api/echo", { private: "s".repeat(140_000) });
    assert.equal(large.status, 413);
    assert.equal((await large.json() as any).code, "PAYLOAD_TOO_LARGE");
    const compressed = await h.request("/api/echo", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: "PRIVATE_TOKEN_BODY" });
    assert.equal(compressed.status, 415);
    assert.equal((await compressed.json() as any).code, "UNSUPPORTED_ENCODING");
  } finally { await h.close(); }
});

test("checkout rate limit is bounded and returns actionable safe JSON", async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 30; index++) {
      const response = await h.post("/api/chapa/initialize");
      assert.equal(response.status, 200);
      await response.body?.cancel();
    }
    const limited = await h.post("/api/chapa/initialize");
    assert.equal(limited.status, 429);
    const body = await limited.json() as any;
    assert.equal(body.code, "CHECKOUT_RATE_LIMITED");
    assert.equal(body.retryAction, "wait");
    assert.ok(limited.headers.get("retry-after"));
  } finally { await h.close(); }
});

function mockStreamResponse() {
  const response = new EventEmitter() as EventEmitter & { statusCode: number; body?: any; ended: boolean; status: (status: number) => any; json: (body: any) => any; end: () => void };
  response.statusCode = 200;
  response.ended = false;
  response.status = (status: number) => { response.statusCode = status; return response; };
  response.json = (body: any) => { response.body = body; response.end(); return response; };
  response.end = () => { response.ended = true; response.emit("finish"); };
  return response;
}

test("SSE caps enforce global and per-IP limits and release slots once on finish or close", () => {
  const limiter = createStreamLimiter(2, 1, 60_000);
  const responses: ReturnType<typeof mockStreamResponse>[] = [];
  const connect = (ip: string) => {
    const response = mockStreamResponse();
    responses.push(response);
    let admitted = false;
    limiter({ ip, socket: { remoteAddress: ip } } as any, response as any, () => { admitted = true; });
    return { response, admitted };
  };
  try {
    const first = connect("192.0.2.1");
    assert.equal(first.admitted, true);
    const sameIp = connect("192.0.2.1");
    assert.equal(sameIp.admitted, false);
    assert.equal(sameIp.response.statusCode, 429);
    assert.equal(sameIp.response.body.code, "SSE_CONNECTION_LIMIT");
    const second = connect("192.0.2.2");
    assert.equal(second.admitted, true);
    const overTotal = connect("192.0.2.3");
    assert.equal(overTotal.admitted, false);
    assert.equal(overTotal.response.statusCode, 429);
    first.response.emit("finish");
    first.response.emit("close");
    const replacement = connect("192.0.2.3");
    assert.equal(replacement.admitted, true);
    assert.equal(connect("192.0.2.4").admitted, false);
    second.response.emit("close");
    assert.equal(connect("192.0.2.4").admitted, true);
    assert.equal(connect("192.0.2.5").admitted, false);
  } finally { responses.forEach(response => response.emit("close")); }
});

test("SSE expiry closes idle streams and returns their connection capacity", async () => {
  const limiter = createStreamLimiter(1, 1, 10);
  const response = mockStreamResponse();
  let admitted = false;
  limiter({ ip: "192.0.2.1", socket: {} } as any, response as any, () => { admitted = true; });
  assert.equal(admitted, true);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("SSE expiry did not close the stream")), 1000);
    response.once("finish", () => { clearTimeout(deadline); resolve(); });
  });
  assert.equal(response.ended, true);
  const replacement = mockStreamResponse();
  let readmitted = false;
  limiter({ ip: "192.0.2.1", socket: {} } as any, replacement as any, () => { readmitted = true; });
  assert.equal(readmitted, true);
  replacement.emit("close");
});
