import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStaffOrderUpdate, orderCanBeFulfilled } from "../order-security";

const admin = { role: "admin", permissions: {} };
const cash = { status: "pending", paymentMethod: "cash", paymentStatus: "pending" };
const online = { ...cash, paymentMethod: "chapa" };

test("manual payment completion is cash-only, irreversible and permission-scoped", () => {
  assert.equal(buildStaffOrderUpdate(cash, { paymentStatus: "completed" }, admin).paymentStatus, "completed");
  assert.throws(() => buildStaffOrderUpdate(online, { paymentStatus: "completed" }, admin), /verification/);
  assert.throws(() => buildStaffOrderUpdate({ ...cash, paymentStatus: "completed" }, { paymentStatus: "pending" }, admin), /Only pending cash/);
  assert.throws(() => buildStaffOrderUpdate(cash, { paymentStatus: "completed" }, { role: "cashier", permissions: {} }), /role/);
  assert.throws(() => buildStaffOrderUpdate({ ...cash, status: "cancelled" }, { paymentStatus: "completed" }, admin), /cancelled/);
});

test("order progress requires a valid paid state, proper transition and permission", () => {
  assert.equal(orderCanBeFulfilled(online), false);
  assert.throws(() => buildStaffOrderUpdate(online, { status: "preparing" }, admin), /verified/);
  assert.throws(() => buildStaffOrderUpdate(cash, { status: "delivered" }, admin), /transition/);
  assert.throws(() => buildStaffOrderUpdate(cash, { status: "anything" }, admin), /Invalid order status/);
  assert.throws(() => buildStaffOrderUpdate(cash, { total: 1 }, admin), /Only order status/);
  assert.equal(buildStaffOrderUpdate(cash, { status: "preparing" }, { role: "cook", permissions: { "kds.startPreparing": true } }).status, "preparing");
  assert.throws(() => buildStaffOrderUpdate({ ...cash, status: "ready" }, { status: "dispatched" }, { role: "cook", permissions: { "kds.markReady": true } }), /role/);
  assert.throws(() => buildStaffOrderUpdate({ ...cash, status: "delivered" }, { status: "pending" }, admin), /closed/);
});

test("verified refunds and payment reconciliation holds stop every fulfillment transition", () => {
  for (const paymentStatus of ["refunded", "reversed"]) {
    const adjusted = { ...online, paymentStatus };
    assert.equal(orderCanBeFulfilled(adjusted), false);
    assert.throws(() => buildStaffOrderUpdate(adjusted, { status: "preparing" }, admin), /verified/);
  }
  const held = { ...online, paymentStatus: "completed", paymentReconciliationRequired: true };
  assert.equal(orderCanBeFulfilled(held), false);
  assert.throws(() => buildStaffOrderUpdate(held, { status: "preparing" }, admin), /verified/);
  assert.equal(orderCanBeFulfilled({ ...held, paymentReconciliationRequired: false, fulfillmentHoldReason: "payment_refunded" }), false);
});

test("uncertain payments and active delivery orders cannot be cancelled", () => {
  assert.throws(() => buildStaffOrderUpdate(online, { status: "cancelled" }, admin), /uncertain/);
  assert.throws(() => buildStaffOrderUpdate({ ...cash, shipdayDispatchState: "reconciling" }, { status: "cancelled" }, admin), /Shipday/);
  assert.equal(buildStaffOrderUpdate({ ...online, failureDefinitive: true }, { status: "cancelled" }, admin).status, "cancelled");
});

test("delivery minutes are bounded and cannot be edited by kitchen permissions", () => {
  assert.deepEqual(buildStaffOrderUpdate(cash, { deliveryMinutes: 0 }, admin), {});
  for (const minutes of [-1, 1.5, 241, "20", null]) assert.throws(() => buildStaffOrderUpdate(cash, { deliveryMinutes: minutes }, admin), /Delivery time/);
  assert.throws(() => buildStaffOrderUpdate(cash, { deliveryMinutes: 20 }, { role: "cook", permissions: { "kds.markReady": true } }), /role/);
});
