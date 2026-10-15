import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  isChapaCheckoutUrl, paymentMinorUnits, expectedChapaMode, chapaPaymentMatchDiagnostics,
  assertChapaWebhookSignature, readChapaJsonResponse, createChapaVerificationClient,
  chapaProviderError, assertVerifiedChapaSettlement, isFinalPaymentStatus, buildVerifiedChapaAdjustment, buildChapaAdjustmentReconciliation, assertNewChapaAttemptCapacity, hasConfirmedChapaFailure
} from "../chapa-security";
import { createLocalStore } from "../local-store";

const secret = "CHASECK_TEST-not-a-real-key";
const txRef = "PAY-security-test";
const order = { id: txRef, transactionRef: txRef, paymentMethod: "chapa", total: 125.5, paymentStatus: "pending" };
const payment = { tx_ref: txRef, amount: "125.50", currency: "ETB", mode: "test", status: "success" };

test("checkout redirect accepts only the exact Chapa checkout origin and hosted paths", () => {
  for (const url of ["https://checkout.chapa.co/checkout/payment/abc123", "https://checkout.chapa.co/checkout/test-payment/abc_123-"]) assert.equal(isChapaCheckoutUrl(url), true);
  for (const url of ["https://evil.example/checkout/payment/a", "https://checkout.chapa.co.evil.example/checkout/payment/a", "https://checkout.chapa.co@evil.example/checkout/payment/a", "https://user@checkout.chapa.co/checkout/payment/a", "http://checkout.chapa.co/checkout/payment/a", "https://checkout.chapa.co:8000/checkout/payment/a", "https://checkout.chapa.co/checkout/payment/a#x", "https://checkout.chapa.co/redirect?to=https://evil.example", "https://checkout.chapa.co\\@evil.example/checkout/payment/a", "javascript:alert(1)", null, {}]) assert.equal(isChapaCheckoutUrl(url), false, String(url));
});

test("amount comparisons use positive exact minor units without coercion", () => {
  assert.equal(paymentMinorUnits("125.50"), 12550);
  assert.equal(paymentMinorUnits(125.5), 12550);
  for (const amount of [null, undefined, [], [125.5], true, {}, "", "1e2", "0x7d", "125.501", "125.499", "-125.50", "0", 0, Infinity, NaN]) assert.equal(paymentMinorUnits(amount), null);
});

test("settlement fails closed for mismatched reference, amount, mode, currency, payment method and changed order", () => {
  assert.equal(chapaPaymentMatchDiagnostics(payment, order, txRef, secret).matches, true);
  assert.doesNotThrow(() => assertVerifiedChapaSettlement(payment, order, txRef, secret));
  for (const changed of [{ ...payment, tx_ref: "other" }, { ...payment, amount: 125.501 }, { ...payment, currency: "USD" }, { ...payment, mode: "live" }, { ...payment, status: "pending" }]) assert.equal(chapaPaymentMatchDiagnostics(changed, order, txRef, secret).matches, false);
  for (const changed of [{ ...order, total: 124.5 }, { ...order, transactionRef: "other" }, { ...order, paymentMethod: "cash" }]) assert.throws(() => assertVerifiedChapaSettlement(payment, changed, txRef, secret), /do not match/);
  assert.equal(chapaPaymentMatchDiagnostics(payment, order, txRef, "unrecognized-format").matches, false);
  assert.equal(expectedChapaMode(secret), "test");
  assert.equal(expectedChapaMode("CHASECK-not-a-real-key"), "live");
  assert.equal(isFinalPaymentStatus("refunded"), true);
  assert.equal(isFinalPaymentStatus("reversed"), true);
  assert.equal(isFinalPaymentStatus("completed"), true);
  assert.equal(isFinalPaymentStatus("pending"), false);
});

test("signature checks support documented headers and reject missing/tampered signatures", () => {
  const body = Buffer.from('{"tx_ref":"PAY-test","status":"success"}');
  const webhookSecret = "test-webhook-secret";
  const payloadHash = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
  const legacyHash = crypto.createHmac("sha256", webhookSecret).update(webhookSecret).digest("hex");
  assert.equal(assertChapaWebhookSignature(body, payloadHash, undefined, webhookSecret), true);
  assert.equal(assertChapaWebhookSignature(body, undefined, payloadHash, webhookSecret), true);
  assert.equal(assertChapaWebhookSignature(body, undefined, legacyHash, webhookSecret), true);
  assert.equal(assertChapaWebhookSignature(Buffer.from("tampered"), payloadHash, undefined, webhookSecret), false);
  assert.equal(assertChapaWebhookSignature(body, undefined, undefined, webhookSecret), false);
  assert.equal(assertChapaWebhookSignature(body, [payloadHash], undefined, webhookSecret), false);
  assert.equal(assertChapaWebhookSignature(body, "0".repeat(64), undefined, webhookSecret), false);
});

test("upstream JSON parser rejects oversized, malformed and non-object bodies", async () => {
  assert.deepEqual(await readChapaJsonResponse(new Response('{"status":"success"}')), { status: "success" });
  await assert.rejects(readChapaJsonResponse(new Response("{")), /invalid response/);
  await assert.rejects(readChapaJsonResponse(new Response("[]")), /invalid response/);
  await assert.rejects(readChapaJsonResponse(new Response('{"large":"' + "a".repeat(100) + '"}'), 64), /invalid response/);
  await assert.rejects(readChapaJsonResponse(new Response("{}", { headers: { "content-length": "1000" } }), 64), /invalid response/);
});

test("verification requests are bounded, coalesced and block redirects", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const verify = createChapaVerificationClient(() => secret, (async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.chapa.co/v1/transaction/verify/" + txRef);
    assert.equal(options.redirect, "error");
    assert.equal((options.headers as any).Authorization, "Bearer " + secret);
    await gate;
    return new Response(JSON.stringify({ status: "success", data: payment }));
  }) as typeof fetch);
  const one = verify(txRef);
  const two = verify(txRef);
  release();
  assert.deepEqual(await one, await two);
  await verify(txRef);
  assert.equal(calls, 1);
  await assert.rejects(verify("../invalid"), /Invalid payment reference/);
});

test("verification errors never expose raw provider data and distinguish unpaid from absent", () => {
  const unpaid = chapaProviderError(404, { message: "Payment not paid yet" });
  const absent = chapaProviderError(404, { message: "Invalid transaction or Transaction not found" });
  assert.equal(unpaid.providerReason, "unpaid");
  assert.equal(absent.providerReason, "not_found");
  assert.equal(chapaProviderError(401, { message: "secret-token customer@example.com" }).message.includes("secret-token"), false);
});

test("payment adjustments require exact provider identity and a prior completed payment", () => {
  const paid = { ...order, paymentStatus: "completed", receipt: { status: "success", reference: "receipt" } };
  for (const status of ["refunded", "reversed"]) {
    const verified = { ...payment, status };
    const adjusted = buildVerifiedChapaAdjustment(verified, paid, txRef, secret, "success", "now")!;
    assert.equal(adjusted.paymentStatus, status);
    assert.equal(adjusted.receipt.status, status);
    assert.equal(adjusted.paymentReconciliationRequired, false);
    assert.equal(adjusted.fulfillmentHoldReason, "payment_" + status);
    assert.equal(buildVerifiedChapaAdjustment(verified, order, txRef, secret, "success"), null);
    assert.equal(buildVerifiedChapaAdjustment(verified, { ...paid, paymentStatus: status }, txRef, secret, "success"), null);
    for (const changed of [{ ...verified, tx_ref: "other" }, { ...verified, amount: 1 }, { ...verified, currency: "USD" }, { ...verified, mode: "live" }]) {
      assert.throws(() => buildVerifiedChapaAdjustment(changed, paid, txRef, secret, "success"), { code: "PAYMENT_DETAILS_MISMATCH" });
    }
    assert.throws(() => buildVerifiedChapaAdjustment(verified, paid, txRef, secret, "failed"), { code: "PAYMENT_DETAILS_MISMATCH" });
  }
  assert.equal(buildVerifiedChapaAdjustment(payment, paid, txRef, secret, "success"), null);
});

test("concurrent adjustment deliveries settle once and late success cannot recomplete them", async () => {
  const db = createLocalStore(":memory:");
  try {
    const ref = db.doc("orders/" + txRef);
    await ref.create({ ...order, paymentStatus: "completed", paymentHistory: [{ paymentStatus: "completed", at: "before" }] });
    const adjust = () => db.runTransaction(async transaction => {
      const current = (await transaction.get(ref)).data();
      const fields = buildVerifiedChapaAdjustment({ ...payment, status: "refunded" }, current, txRef, secret, "success");
      if (fields) transaction.update(ref, fields);
    });
    await Promise.all([adjust(), adjust()]);
    const current = (await ref.get()).data()!;
    assert.equal(current.paymentStatus, "refunded");
    assert.equal(current.paymentHistory.length, 2);
    assert.equal(isFinalPaymentStatus(current.paymentStatus), true);
    assert.equal(buildVerifiedChapaAdjustment({ ...payment, status: "reversed" }, current, txRef, secret, "success"), null);
  } finally { db.close(); }
});

test("unconfirmed adjustment events preserve payment truth and pause fulfillment", () => {
  const paid = { ...order, paymentStatus: "completed", paymentAttemptStatus: "success" };
  for (const verified of [null, payment, { ...payment, status: "refunded", amount: 1 }]) {
    const fields = buildChapaAdjustmentReconciliation(verified, paid, txRef, secret, "success", true)!;
    assert.equal(fields.paymentReconciliationRequired, true);
    assert.equal(fields.paymentVerificationIssue, "payment_adjustment_unconfirmed");
    assert.equal(Object.hasOwn(fields, "paymentStatus"), false);
    assert.equal(Object.hasOwn(fields, "paymentAttemptStatus"), false);
  }
  assert.equal(buildChapaAdjustmentReconciliation(payment, paid, txRef, secret, "success"), null);
  assert.deepEqual(buildChapaAdjustmentReconciliation(payment, { ...paid, paymentStatus: "refunded" }, txRef, secret, "success", true), {});
  assert.deepEqual(buildChapaAdjustmentReconciliation(payment, { ...paid, paymentMethod: "cash" }, txRef, secret, "success", true), {});
  const fields = buildChapaAdjustmentReconciliation({ ...payment, status: "refunded" }, order, txRef, secret, "success")!;
  assert.equal(fields.paymentAttemptStatus, "reconciling");
  assert.equal(Object.hasOwn(fields, "paymentStatus"), false);
});

test("active checkout capacity includes uncertain/cancel-requested references but excludes settled or confirmed unusable ones", async () => {
  const db = createLocalStore(":memory:");
  const uid = "customer-capacity-test";
  const pending = { userId: uid, paymentMethod: "chapa", paymentStatus: "pending", status: "pending" };
  try {
    await db.doc("orders/active-one").create({ ...pending, paymentAttemptStatus: "ready" });
    await db.doc("orders/active-two").create({ ...pending, paymentAttemptStatus: "reconciling", status: "cancel_requested" });
    await db.doc("orders/paid").create({ ...pending, paymentStatus: "completed" });
    await db.doc("orders/refunded").create({ ...pending, paymentStatus: "refunded" });
    await db.doc("orders/reversed").create({ ...pending, paymentStatus: "reversed" });
    await db.doc("orders/cash").create({ ...pending, paymentMethod: "cash" });
    await db.doc("orders/other-customer").create({ ...pending, userId: "other" });
    await db.doc("orders/rejected").create({ ...pending, failureDefinitive: true, initializationRejectedAt: "then" });
    await db.runTransaction(transaction => assertNewChapaAttemptCapacity(transaction, db, uid));
    await db.doc("orders/legacy-unsafe").create({ ...pending, failureDefinitive: true });
    await assert.rejects(db.runTransaction(transaction => assertNewChapaAttemptCapacity(transaction, db, uid)), { code: "CHECKOUT_ACTIVE_ATTEMPT_LIMIT", retryAction: "wait" });
    assert.equal(hasConfirmedChapaFailure({ failureDefinitive: true }), false);
    assert.equal(hasConfirmedChapaFailure({ failureDefinitive: true, providerCancelledAt: "then" }), true);
    assert.equal(hasConfirmedChapaFailure({ failureDefinitive: true, providerNotFoundConfirmedAt: "then" }), true);
  } finally { db.close(); }
});

test("distinct checkout IDs cannot race past the customer's active checkout cap", async () => {
  const db = createLocalStore(":memory:");
  const uid = "customer-capacity-race";
  const pending = { userId: uid, paymentMethod: "chapa", paymentStatus: "pending", status: "pending", paymentAttemptStatus: "initializing" };
  try {
    await db.doc("orders/existing-one").create(pending);
    await db.doc("orders/existing-two").create(pending);
    const create = (id: string) => db.runTransaction(async transaction => {
      await assertNewChapaAttemptCapacity(transaction, db, uid);
      transaction.create(db.doc("orders/" + id), pending);
    });
    const results = await Promise.allSettled([create("new-one"), create("new-two"), create("new-three")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await db.collection("orders").get()).size, 3);
    for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "CHECKOUT_ACTIVE_ATTEMPT_LIMIT");
  } finally { db.close(); }
});
