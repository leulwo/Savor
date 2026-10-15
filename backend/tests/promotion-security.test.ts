import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalStore } from "../local-store";
import { promotionCapacity, promotionDiscount, reserveOrderPromotion, completeOrderPromotion, releaseOrderPromotion, acceptCashOrderPromotion } from "../promotion-security";

const discountedOrder = { promoCode: "SAVE", discountAmount: 10, items: [{ menuItem: { price: 100 }, quantity: 1 }] };

test("promotion limits include active hosted checkouts and validate promo values", () => {
  assert.equal(promotionCapacity({ maxUsages: 2, usageCount: 1, reservedCount: 1 }), false);
  assert.equal(promotionCapacity({ maxUsages: 2, usageCount: 1, reservedCount: 0 }), true);
  assert.equal(promotionCapacity({ maxUsages: -1 }), false);
  assert.equal(promotionDiscount({ active: true, type: "percentage", value: 10 }, 100), 10);
  assert.throws(() => promotionDiscount({ active: false, type: "percentage", value: 10 }, 100));
  assert.throws(() => promotionDiscount({ type: "percentage", value: 1000 }, 100));
  assert.throws(() => promotionDiscount({ type: "fixed", value: 10, expiresAt: "invalid-date" }, 100));
});

test("concurrent discounted checkouts cannot both claim the final promotion slot", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("promoCodes/SAVE").create({ type: "percentage", value: 10, active: true, maxUsages: 1, usageCount: 0 });
    const claim = (id: string) => db.runTransaction(async transaction => {
      const fields = await reserveOrderPromotion(transaction, db, discountedOrder);
      transaction.create(db.doc("orders/" + id), { ...discountedOrder, ...fields });
    });
    const results = await Promise.allSettled([claim("one"), claim("two")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("reservedCount"), 1);
    assert.equal((await db.collection("orders").get()).size, 1);
  } finally { db.close(); }
});

test("paid transition converts a reservation exactly once in the order transaction", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("promoCodes/SAVE").create({ type: "fixed", value: 10, maxUsages: 1, usageCount: 0, reservedCount: 1 });
    await db.doc("orders/one").create({ ...discountedOrder, promoReserved: true });
    const settle = () => db.runTransaction(async transaction => {
      const ref = db.doc("orders/one");
      const order = (await transaction.get(ref)).data();
      const fields = await completeOrderPromotion(transaction, db, order);
      transaction.update(ref, { ...fields, paymentStatus: "completed" });
    });
    await Promise.all([settle(), settle()]);
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("usageCount"), 1);
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("reservedCount"), 0);
    assert.equal((await db.doc("orders/one").get()).get("promoApplied"), true);
  } finally { db.close(); }
});

test("definitive rejection releases capacity without decrementing redeemed usage", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("promoCodes/SAVE").create({ type: "fixed", value: 10, usageCount: 2, reservedCount: 1 });
    await db.runTransaction(async transaction => {
      const fields = await releaseOrderPromotion(transaction, db, { ...discountedOrder, promoReserved: true });
      assert.deepEqual(fields, { promoReserved: false });
    });
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("usageCount"), 2);
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("reservedCount"), 0);
  } finally { db.close(); }
});

test("claim rejects a promotion modified after pricing", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("promoCodes/SAVE").create({ type: "fixed", value: 1, usageCount: 0 });
    await assert.rejects(db.runTransaction(transaction => reserveOrderPromotion(transaction, db, discountedOrder)), { code: "CHECKOUT_PROMO_CHANGED" });
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("reservedCount"), undefined);
  } finally { db.close(); }
});

test("cash acceptance cannot consume capacity reserved by an online checkout", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("promoCodes/SAVE").create({ type: "fixed", value: 10, maxUsages: 1, usageCount: 0, reservedCount: 1 });
    await assert.rejects(db.runTransaction(transaction => acceptCashOrderPromotion(transaction, db, discountedOrder)), { code: "CHECKOUT_PROMO_LIMIT_REACHED" });
    await db.doc("promoCodes/SAVE").update({ reservedCount: 0 });
    await db.runTransaction(async transaction => {
      const fields = await acceptCashOrderPromotion(transaction, db, discountedOrder);
      assert.equal(fields.promoApplied, true);
      transaction.create(db.doc("orders/cash"), { ...discountedOrder, ...fields });
    });
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("usageCount"), 1);
  } finally { db.close(); }
});

test("reconciliation releases an absent checkout reservation atomically and exactly once", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("promoCodes/SAVE").create({ type: "fixed", value: 10, maxUsages: 1, usageCount: 0, reservedCount: 1 });
    const ref = db.doc("orders/absent");
    await ref.create({ ...discountedOrder, promoReserved: true, paymentStatus: "pending", paymentAttemptStatus: "reconciling" });
    const release = () => db.runTransaction(async transaction => {
      const current = (await transaction.get(ref)).data();
      const fields = await releaseOrderPromotion(transaction, db, current);
      transaction.update(ref, { ...fields, paymentAttemptStatus: "failed", failureDefinitive: true });
    });
    await Promise.all([release(), release()]);
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("reservedCount"), 0);
    assert.equal((await db.doc("promoCodes/SAVE").get()).get("usageCount"), 0);
    assert.equal((await ref.get()).get("promoReserved"), false);
    assert.equal(promotionCapacity((await db.doc("promoCodes/SAVE").get()).data()), true);
  } finally { db.close(); }
});
