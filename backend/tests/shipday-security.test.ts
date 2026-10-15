import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createLocalStore } from "../local-store";
import { createShipdayService, installShipdayRoutes, validShipdayWebhookToken } from "../shipday-security";

const order = { paymentMethod: "cash", paymentStatus: "pending", status: "ready", fulfillmentType: "delivery", total: 125.5, customerName: "Test Customer", customerPhone: "0912345678", customerEmail: "customer@example.com", googleMapsAddress: "Test address", items: [{ menuItem: { name: "Coffee", price: 125.5 }, quantity: 1 }] };
const options = { getApiKey: () => "fake-key", getWebhookToken: () => "fake-webhook-secret" };

test("Shipday dispatch claims prevent concurrent and repeated provider creation", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("orders/one").create(order);
    let calls = 0;
    let release!: () => void;
    let called!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchCalled = new Promise<void>(resolve => { called = resolve; });
    const service = createShipdayService(db, { ...options, fetcher: (async (_url: string, init: RequestInit) => {
      calls++;
      assert.equal(init.redirect, "error");
      const payload = JSON.parse(String(init.body));
      assert.equal(payload.orderItem[0].name, "Coffee");
      assert.equal(payload.customerPhoneNumber, "+251912345678");
      called();
      await gate;
      return new Response(JSON.stringify({ success: true, orderId: 42 }));
    }) as typeof fetch });
    const first = service.create("one");
    await fetchCalled;
    await assert.rejects(service.create("one"), { code: "SHIPDAY_RECONCILING" });
    release();
    const created = await first;
    assert.equal(created.shipdayOrderId, "42");
    const repeated = await service.create("one");
    assert.equal(repeated.reused, true);
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test("unpaid online, unready and non-delivery orders never contact Shipday", async () => {
  const db = createLocalStore(":memory:");
  try {
    let calls = 0;
    const service = createShipdayService(db, { ...options, fetcher: (async () => { calls++; throw new Error("must not call"); }) as typeof fetch });
    await db.doc("orders/unpaid").create({ ...order, paymentMethod: "chapa" });
    await db.doc("orders/unready").create({ ...order, status: "pending" });
    await db.doc("orders/pickup").create({ ...order, fulfillmentType: "pickup" });
    await db.doc("orders/held").create({ ...order, paymentMethod: "chapa", paymentStatus: "completed", paymentReconciliationRequired: true });
    await db.doc("orders/refunded").create({ ...order, paymentMethod: "chapa", paymentStatus: "refunded" });
    for (const id of ["unpaid", "unready", "pickup", "held", "refunded"]) await assert.rejects(service.create(id));
    assert.equal(calls, 0);
  } finally { db.close(); }
});

test("lost provider responses are persisted uncertain and cannot create duplicate deliveries", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("orders/one").create(order);
    let calls = 0;
    const service = createShipdayService(db, { ...options, fetcher: (async () => { calls++; throw new TypeError("network lost"); }) as typeof fetch });
    await assert.rejects(service.create("one"), /interrupted/);
    assert.equal((await db.doc("orders/one").get()).get("shipdayDispatchState"), "reconciling");
    await assert.rejects(service.create("one"), { code: "SHIPDAY_RECONCILING" });
    assert.equal(calls, 1);
  } finally { db.close(); }
});

test("invalid provider URLs cannot become tracking links and errors do not contain raw bodies", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("orders/one").create(order);
    const service = createShipdayService(db, { ...options, fetcher: (async () => new Response(JSON.stringify({ success: true, orderId: 42, trackingLink: "javascript:alert(1)" }))) as typeof fetch });
    assert.equal((await service.create("one")).trackingLink, null);
    await db.doc("orders/two").create(order);
    const reject = createShipdayService(db, { ...options, fetcher: (async () => new Response("secret-key customer@example.com", { status: 401 })) as typeof fetch });
    await assert.rejects(reject.create("two"), (error: any) => !error.message.includes("secret-key") && !error.message.includes("customer@example.com"));
  } finally { db.close(); }
});

test("webhook must match an existing association and cannot fulfill unpaid online orders", async () => {
  const db = createLocalStore(":memory:");
  try {
    const service = createShipdayService(db, options);
    const hook = (id: string, providerId = 42) => ({ order: { id: providerId, order_number: id }, order_status: "ALREADY_DELIVERED" });
    assert.equal((await service.processWebhook(hook("unknown"))).changed, false);
    assert.equal((await db.doc("orders/unknown").get()).exists, false);
    await db.doc("orders/one").create({ ...order, shipdayOrderId: "42" });
    assert.equal((await service.processWebhook(hook("one", 43))).changed, false);
    await db.doc("orders/unpaid").create({ ...order, paymentMethod: "chapa", shipdayOrderId: "42" });
    assert.equal((await service.processWebhook(hook("unpaid"))).changed, false);
    assert.equal((await db.doc("orders/unpaid").get()).get("status"), "ready");
    assert.equal((await service.processWebhook(hook("one"))).changed, true);
    assert.equal((await db.doc("orders/one").get()).get("status"), "delivered");
  } finally { db.close(); }
});

test("webhook replay and stale events cannot regress a completed delivery", async () => {
  const db = createLocalStore(":memory:");
  try {
    const service = createShipdayService(db, options);
    await db.doc("orders/one").create({ ...order, shipdayOrderId: "42" });
    const base = { order: { id: 42, order_number: "one" } };
    const now = Date.now();
    await service.processWebhook({ ...base, timestamp: now, order_status: "PICKED_UP" });
    assert.equal((await db.doc("orders/one").get()).get("status"), "dispatched");
    assert.equal((await service.processWebhook({ ...base, timestamp: now - 1, order_status: "FAILED_DELIVERY" })).changed, false);
    await service.processWebhook({ ...base, timestamp: now + 1, order_status: "ALREADY_DELIVERED" });
    assert.equal((await service.processWebhook({ ...base, timestamp: now + 2, order_status: "FAILED_DELIVERY" })).changed, false);
    assert.equal((await db.doc("orders/one").get()).get("status"), "delivered");
    assert.equal((await db.doc("orders/one").get()).get("statusHistory").length, 2);
  } finally { db.close(); }
});

test("webhook token comparison fails closed and accepts the documented token header", async () => {
  assert.equal(validShipdayWebhookToken("secret", "secret"), true);
  assert.equal(validShipdayWebhookToken("different", "secret"), false);
  assert.equal(validShipdayWebhookToken(undefined, "secret"), false);
  assert.equal(validShipdayWebhookToken("", ""), false);
  const db = createLocalStore(":memory:");
  const app = express();
  app.use(express.json());
  installShipdayRoutes(app, createShipdayService(db, options), { requireStaffAuth: (_req, res) => { res.status(401).end(); }, requireStaffPermission: () => (_req, _res, next) => next() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const port = (server.address() as any).port;
    const body = JSON.stringify({ order: { id: 42, order_number: "missing" }, order_status: "ALREADY_DELIVERED" });
    const bad = await fetch(`http://127.0.0.1:${port}/api/shipday/webhook`, { method: "POST", body, headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 401);
    const good = await fetch(`http://127.0.0.1:${port}/api/shipday/webhook`, { method: "POST", body, headers: { "content-type": "application/json", token: options.getWebhookToken() } });
    assert.equal(good.status, 200);
    const protectedRoute = await fetch(`http://127.0.0.1:${port}/api/shipday/order`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(protectedRoute.status, 401);
  } finally { server.close(); db.close(); }
});
