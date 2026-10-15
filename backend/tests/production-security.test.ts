import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalStore } from "../local-store";
import { orderCanBeFulfilled } from "../order-security";

// These tests start the actual production entry point, with a disposable root
// and an allowlisted environment. They cannot load the developer's .env, SQLite
// database, Firebase credentials or payment/delivery API credentials.
const backendRoot = path.resolve(__dirname, "..");
const localRequire = createRequire(path.join(backendRoot, "package.json"));
const tsxLoader = localRequire.resolve("tsx/cjs");
const publicOrigin = "https://restaurant-security-fixture.invalid";
const pendingId = "PAY-production-security-fixture";
const dispatchId = "delivery-security-fixture";
const privateMarker = "PRIVATE_CUSTOMER_SECURITY_FIXTURE";
const syntheticChapaKey = "CHASECK_TEST-fixture-only";
const syntheticWebhookSecret = "fixture-only-chapa-webhook-value-932018";
const pendingOrder = { id: pendingId, transactionRef: pendingId, userId: "fixture-customer", customerName: privateMarker, paymentMethod: "chapa", paymentStatus: "pending", attemptStatus: "ready", status: "pending", total: 125.5, currency: "ETB" };
const deliveryOrder = { id: dispatchId, userId: "fixture-customer", customerName: privateMarker, paymentMethod: "cash", paymentStatus: "pending", status: "ready", fulfillmentType: "delivery", shipdayOrderId: "1234567" };

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

type VerificationFixture = { body: Record<string, any>; status?: number };
async function fixture(options: { appUrl?: string; start?: boolean; orders?: Record<string, any>; verification?: Record<string, VerificationFixture> } = {}) {
  const prefix = path.join(os.tmpdir(), "savory-production-security-");
  const root = await fs.mkdtemp(prefix);
  assert.ok(root.startsWith(prefix));
  const databasePath = path.join(root, "data", "fixture.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.mkdir(path.join(root, "frontend", "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "frontend", "dist", "index.html"), "<!doctype html><html><body>Production security fixture</body></html>");
  await fs.writeFile(path.join(root, "data", "db.json"), JSON.stringify({ orders: options.orders || { [pendingId]: pendingOrder, [dispatchId]: deliveryOrder } }));
  const guardPath = path.join(root, "deny-external-requests.cjs");
  const verificationCallsPath = path.join(root, "synthetic-verification-calls.jsonl");
  const verificationUrls = Object.fromEntries(Object.entries(options.verification || {}).map(([reference, value]) => {
    assert.match(reference, /^PAY-[A-Za-z0-9_-]+$/);
    return ["https://api.chapa.co/v1/transaction/verify/" + reference, value];
  }));
  // Even an accidental regression cannot contact a provider. Adjustment tests
  // optionally substitute Responses for exact, synthetic read-only verify URLs.
  await fs.writeFile(guardPath, `
const denied = () => { throw new Error("External network access is disabled in production security tests"); };
const allowedVerification = new Map(Object.entries(${JSON.stringify(verificationUrls)}));
globalThis.fetch = async (url, options) => {
  if (typeof url !== "string" || !allowedVerification.has(url) || options?.method !== "GET" || options?.redirect !== "error" || options?.headers?.Authorization !== ${JSON.stringify("Bearer " + syntheticChapaKey)}) return denied();
  require("node:fs").appendFileSync(${JSON.stringify(verificationCallsPath)}, JSON.stringify({ url, method: options.method }) + "\\n");
  const stub = allowedVerification.get(url);
  return new Response(JSON.stringify(stub.body), { status: stub.status || 200, headers: { "content-type": "application/json" } });
};
for (const name of ["node:http", "node:https"]) {
  const transport = require(name);
  transport.request = denied;
  transport.get = denied;
}
`);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    NODE_ENV: "production", APP_ROOT: root, DATABASE_PATH: databasePath,
    VITE_FIREBASE_PROJECT_ID: "savory-security-fixture", VITE_FIREBASE_AUTH_DOMAIN: "",
    PRIMARY_ADMIN_EMAIL: "fixture-owner@restaurant.invalid",
    CHAPA_WEBHOOK_SECRET: syntheticWebhookSecret,
    SHIPDAY_WEBHOOK_TOKEN: "fixture-only-shipday-webhook-value-410923",
  });
  if (Object.keys(verificationUrls).length) environment.CHAPA_SECRET_KEY = syntheticChapaKey;
  if (options.appUrl !== undefined) environment.APP_URL = options.appUrl;
  const port = options.start === false ? 0 : await availablePort();
  environment.PORT = String(port);
  const child = spawn(process.execPath, ["--require", guardPath, "--require", tsxLoader, path.join(backendRoot, "server.ts")], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); };
  child.stdout!.on("data", capture);
  child.stderr!.on("data", capture);
  const exited = once(child, "exit").then(([code]) => code as number | null);
  const base = `http://127.0.0.1:${port}`;
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, new Promise<never>((_resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Fixture child did not stop")), 5000);
      deadline.unref();
    })]);
  }
  async function close() {
    await stop();
    // Only the exact mkdtemp directory from this fixture is ever removed.
    const target = path.resolve(root);
    assert.ok(target.startsWith(path.resolve(prefix)) && path.dirname(target) === path.resolve(os.tmpdir()));
    await fs.rm(target, { recursive: true, force: true });
  }
  async function ready() {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated production server exited: ${output}`);
      try {
        const response = await fetch(base + "/health", { signal: AbortSignal.timeout(500) });
        if (response.ok) { await response.body?.cancel(); return; }
        await response.body?.cancel();
      } catch { /* Await this fixture's own listener, never an existing server. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Isolated production server did not become ready: ${output}`);
  }
  return {
    root, databasePath, child, exited, output: () => output, ready, stop, close,
    request(resource: string, init: RequestInit = {}) { return fetch(base + resource, { ...init, signal: AbortSignal.timeout(10_000) }); },
    post(resource: string, body: any = {}, headers: Record<string, string> = {}) { return fetch(base + resource, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); },
    readOrder(reference: string) {
      const sqlite = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = sqlite.prepare("SELECT data FROM local_documents WHERE path=?").get("orders/" + reference) as { data: string } | undefined;
        assert.ok(row, "Synthetic order must exist");
        return JSON.parse(row.data);
      } finally { sqlite.close(); }
    },
    async verificationCalls() {
      const entries = await fs.readFile(verificationCallsPath, "utf8").catch(error => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return entries.trim() ? entries.trim().split("\n").map(line => JSON.parse(line)) : [];
    },
  };
}

test("production startup fails closed when APP_URL is absent or insecure", async () => {
  for (const appUrl of [undefined, "http://restaurant-security-fixture.invalid"]) {
    const h = await fixture({ appUrl, start: false });
    try {
      const code = await Promise.race([h.exited, new Promise<never>((_resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("Invalid production configuration did not stop startup")), 10_000);
        deadline.unref();
      })]);
      assert.notEqual(code, 0);
      assert.match(h.output(), /APP_URL.*(?:required|HTTPS)/);
      assert.doesNotMatch(h.output(), /\[SERVER\] Ready/);
      await assert.rejects(fs.access(h.databasePath));
    } finally { await h.close(); }
  }
});

test("real production server rejects unauthorized mutations and forged provider events", async t => {
  const h = await fixture({ appUrl: publicOrigin });
  t.after(() => h.close());
  await h.ready();

  await t.test("staff and owner endpoints require authentication", async () => {
    const routes = [
      ["GET", "/api/orders"], ["GET", "/api/customers"], ["GET", "/api/business/export"],
      ["GET", "/api/mailchimp/test"], ["GET", "/api/shipday/test"],
      ["POST", "/api/settings"], ["POST", "/api/menu"], ["POST", "/api/categories"],
      ["POST", "/api/business/clear"], ["POST", "/api/shipday/order"],
      ["PATCH", "/api/orders/fixture"], ["DELETE", "/api/menu/fixture"], ["DELETE", "/api/categories/fixture"],
      ["GET", `/api/chapa/verify/${pendingId}`], ["GET", `/api/chapa/attempt/${pendingId}`],
      ["POST", `/api/orders/${pendingId}/cancel`], ["POST", "/api/orders"], ["POST", "/api/chapa/initialize"],
    ];
    for (const [method, resource] of routes) {
      const response = await h.request(resource, { method });
      assert.equal(response.status, 401, `${method} ${resource}`);
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      assert.doesNotMatch(await response.text(), new RegExp(privateMarker));
    }
  });

  await t.test("generic database API does not expose private collections or accept anonymous writes", async () => {
    for (const resource of ["orders", "users", "admins", "roles", "carts", "audit_log", "reservations", "chat_messages"]) {
      const response = await h.post("/api/database/query", { path: resource, kind: "collection" });
      assert.ok([401, 403].includes(response.status), resource);
      assert.doesNotMatch(await response.text(), new RegExp(privateMarker));
    }
    const response = await h.post("/api/database/commit", { writes: [{ type: "set", path: `orders/${pendingId}`, data: { paymentStatus: "completed" } }] });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as any).code, "AUTH_SESSION_EXPIRED");
  });

  await t.test("invalid Firebase credentials cannot authenticate API requests", async () => {
    for (const headers of [{ authorization: "Bearer definitely-not-a-jwt" }, { "x-firebase-token": "definitely-not-a-jwt" }]) {
      const response = await h.request("/api/orders", { headers });
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /definitely-not-a-jwt|PRIVATE_CUSTOMER/);
    }
    const response = await h.post("/api/database/query", { path: "orders", kind: "collection" }, { authorization: "Bearer definitely-not-a-jwt" });
    assert.equal(response.status, 401);
  });

  await t.test("forged Chapa and Shipday signatures are rejected before settlement", async () => {
    for (const headers of [{}, { "x-chapa-signature": "0".repeat(64) }, { "chapa-signature": "0".repeat(64) }]) {
      const response = await h.post("/api/chapa/webhook", { tx_ref: pendingId, event: "charge.success", status: "success", amount: "125.50", currency: "ETB" }, headers);
      assert.equal(response.status, 401);
      assert.doesNotMatch(await response.text(), /fixture-only|PRIVATE_CUSTOMER/);
    }
    for (const headers of [{}, { token: "wrong-synthetic-token" }, { "x-shipday-token": "wrong-synthetic-token" }]) {
      const response = await h.post("/api/shipday/webhook", { orderNumber: dispatchId, orderId: 1234567, status: "DELIVERED" }, headers);
      assert.equal(response.status, 401);
    }
  });

  await t.test("malformed JSON and prototype keys receive safe JSON errors", async () => {
    for (const resource of ["/api/database/commit", "/api/settings", "/api/chapa/initialize"]) {
      const response = await h.request(resource, { method: "POST", headers: { "content-type": "application/json" }, body: '{"PRIVATE_MALFORMED_FIXTURE":' });
      assert.equal(response.status, 400);
      assert.match(response.headers.get("content-type") || "", /application\/json/);
      const body = await response.text();
      assert.doesNotMatch(body, /PRIVATE_MALFORMED|SyntaxError|stack|<html|server\.ts|node_modules/i);
      assert.equal(typeof JSON.parse(body).error, "string");
    }
    for (const body of ['{"__proto__":{"polluted":true}}', '{"profile.constructor.prototype":{"polluted":true}}']) {
      const response = await h.request("/api/database/commit", { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as any).code, "INVALID_REQUEST_BODY");
    }
    assert.equal((Object.prototype as any).polluted, undefined);
  });

  await t.test("production security headers preserve OAuth compatibility and disable API caching", async () => {
    const response = await h.request("/");
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Production security fixture/);
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
    assert.match(response.headers.get("strict-transport-security") || "", /max-age=31536000/);
    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.match(csp, /https:\/\/apis\.google\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/accounts\.google\.com/);
    assert.doesNotMatch(csp.match(/script-src [^;]*/)?.[0] || "", /'unsafe-inline'|'unsafe-eval'/);
    const api = await h.request("/api/settings");
    assert.equal(api.status, 200);
    assert.match(api.headers.get("cache-control") || "", /no-store/);
    const auth = await h.request("/__/auth/handler");
    assert.equal(auth.status, 503); // No configured Firebase upstream; no network.
    assert.equal(auth.headers.get("content-security-policy"), null);
    assert.equal(auth.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
    assert.match(auth.headers.get("cache-control") || "", /no-store/);
  });

  await t.test("unknown APIs return JSON instead of the SPA and poisoned host headers cannot bypass origin checks", async () => {
    const absent = await h.request("/api/definitely-missing-endpoint");
    assert.equal(absent.status, 404);
    assert.match(absent.headers.get("content-type") || "", /application\/json/);
    assert.deepEqual(await absent.json(), { error: "API endpoint not found." });
    const headers = { host: "attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "http", origin: "https://attacker.invalid" };
    const forged = await h.post("/api/settings", {}, headers);
    assert.equal(forged.status, 403);
    assert.equal((await forged.json() as any).code, "ORIGIN_FORBIDDEN");
    const configured = await h.post("/api/settings", {}, { ...headers, origin: publicOrigin });
    assert.equal(configured.status, 401);
    const redirect = await h.request("/api/chapa/callback?tx_ref=invalid%2Freference", { headers, redirect: "manual" });
    assert.equal(redirect.status, 302);
    const destination = redirect.headers.get("location") || "";
    assert.ok(destination.startsWith("/?payment_return=1"));
    assert.doesNotMatch(destination, /attacker\.invalid/);
  });

  await t.test("rejected requests leave persisted payment and delivery state unchanged", async () => {
    await h.stop();
    const store = createLocalStore(h.databasePath);
    try {
      assert.deepEqual((await store.doc(`orders/${pendingId}`).get()).data(), pendingOrder);
      assert.deepEqual((await store.doc(`orders/${dispatchId}`).get()).data(), deliveryOrder);
    } finally { store.close(); }
  });
});

test("real signed adjustment webhooks require provider verification and preserve terminal payment truth", async t => {
  const paid = (reference: string) => ({
    ...pendingOrder, id: reference, transactionRef: reference, paymentStatus: "completed", paymentAttemptStatus: "success", status: "ready",
    receipt: { transactionId: "synthetic-receipt", reference: "synthetic-receipt", amount: 125.5, currency: "ETB", status: "success" },
    paymentHistory: [{ paymentStatus: "completed", at: "before-adjustment" }],
  });
  const cases = [
    { id: "PAY-verified-refund-fixture", eventStatus: "refunded", provider: { status: "refunded" }, adjusted: true },
    { id: "PAY-verified-reversal-fixture", eventStatus: "reversed", provider: { status: "reversed" }, adjusted: true },
    { id: "PAY-wrong-mode-fixture", eventStatus: "reversed", provider: { status: "reversed", mode: "live" }, adjusted: false },
    { id: "PAY-wrong-amount-fixture", eventStatus: "refunded", provider: { status: "refunded", amount: "1.00" }, adjusted: false },
    { id: "PAY-wrong-reference-fixture", eventStatus: "reversed", provider: { status: "reversed", tx_ref: "PAY-unrelated-fixture" }, adjusted: false },
    { id: "PAY-wrong-currency-fixture", eventStatus: "refunded", provider: { status: "refunded", currency: "USD" }, adjusted: false },
    { id: "PAY-still-success-fixture", eventStatus: "reversed", provider: { status: "success" }, adjusted: false },
    { id: "PAY-verify-unavailable-fixture", eventStatus: "refunded", provider: { status: "refunded" }, adjusted: false, httpStatus: 503 },
  ];
  const orders = Object.fromEntries(cases.map(item => [item.id, paid(item.id)]));
  const verification = Object.fromEntries(cases.map(item => [item.id, {
    body: { status: "success", data: { tx_ref: item.id, amount: "125.50", currency: "ETB", mode: "test", reference: "synthetic-receipt", ...item.provider } },
    status: item.httpStatus || 200,
  }]));
  const h = await fixture({ appUrl: publicOrigin, orders, verification });
  t.after(() => h.close());
  await h.ready();
  const signedEvent = (reference: string, status: string) => {
    const body = { webhook_type: "payment", tx_ref: reference, event: "charge." + status, status };
    const signature = createHmac("sha256", syntheticWebhookSecret).update(JSON.stringify(body)).digest("hex");
    return h.post("/api/chapa/webhook", body, { "x-chapa-signature": signature });
  };

  for (const scenario of cases) {
    await t.test(scenario.id, async () => {
      const response = await signedEvent(scenario.id, scenario.eventStatus);
      assert.equal(response.status, scenario.httpStatus ? 503 : 200);
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      assert.doesNotMatch(await response.text(), /CHASECK_TEST|fixture-only-chapa|PRIVATE_CUSTOMER/);
      const current = h.readOrder(scenario.id);
      assert.equal(current.status, "ready");
      assert.equal(orderCanBeFulfilled(current), false, "Financial adjustments and reconciliation must pause fulfillment");
      assert.equal(current.receipt.reference, "synthetic-receipt");
      if (scenario.adjusted) {
        // One committed snapshot contains the financial state, receipt state,
        // fulfillment hold and exactly one corresponding history entry.
        assert.equal(current.paymentStatus, scenario.eventStatus);
        assert.equal(current.receipt.status, scenario.eventStatus);
        assert.equal(current.paymentReconciliationRequired, false);
        assert.equal(current.fulfillmentHoldReason, "payment_" + scenario.eventStatus);
        assert.ok(current.paymentAdjustedAt);
        assert.equal(current.paymentHistory.length, 2);
        assert.equal(current.paymentHistory[1].paymentStatus, scenario.eventStatus);
        assert.equal(current.paymentHistory[1].at, current.paymentAdjustedAt);
        const repeated = await Promise.all(Array.from({ length: 4 }, () => signedEvent(scenario.id, scenario.eventStatus)));
        for (const duplicate of repeated) { assert.equal(duplicate.status, 200); await duplicate.body?.cancel(); }
        assert.deepEqual(h.readOrder(scenario.id), current, "Repeated signed deliveries must not change terminal state or append history");
      } else {
        assert.equal(current.paymentStatus, "completed");
        assert.equal(current.receipt.status, "success");
        assert.equal(current.paymentReconciliationRequired, true);
        assert.equal(current.paymentVerificationIssue, "payment_adjustment_unconfirmed");
        assert.equal(current.paymentAdjustedAt, undefined);
        assert.deepEqual(current.paymentHistory, orders[scenario.id].paymentHistory);
      }

      const callsBefore = (await h.verificationCalls()).length;
      const lateSuccess = await signedEvent(scenario.id, "success");
      assert.equal(lateSuccess.status, 200);
      await lateSuccess.body?.cancel();
      assert.deepEqual(h.readOrder(scenario.id), current, "A late success event must not recomplete an adjusted payment or clear an unresolved hold");
      assert.equal((await h.verificationCalls()).length, callsBefore);
    });
  }
  const calls = await h.verificationCalls();
  assert.equal(calls.length, cases.length, "Only exact fixture verification GET requests may run");
  assert.ok(calls.every(call => call.method === "GET" && Object.hasOwn(verification, call.url.slice("https://api.chapa.co/v1/transaction/verify/".length))));
});
