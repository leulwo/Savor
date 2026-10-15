import { test } from "node:test";
import assert from "node:assert/strict";
import { mapChapaFailure, normalizeChapaMessage, safeChapaDiagnostic } from "../chapa-errors";
import { createChapaCustomization } from "../chapa-payload";

test("normalizes nested validation messages and arrays into readable text", () => {
  assert.equal(
    normalizeChapaMessage({ message: { phone_number: ["invalid phone", "required"] } }),
    "phone_number: invalid phone; required"
  );
  assert.notEqual(normalizeChapaMessage({ message: { field: "invalid" } }), "[object Object]");
});

test("maps gateway errors to safe retry actions", () => {
  assert.equal(mapChapaFailure(401, { message: "Unauthorized" }).code, "CHAPA_AUTH_REJECTED");
  assert.equal(mapChapaFailure(404, { message: "API disabled" }).code, "CHAPA_API_DISABLED");
  assert.equal(mapChapaFailure(400, { message: "Duplicate transaction reference" }).retryAction, "wait");
  assert.equal(mapChapaFailure(400, { errors: { phone_number: ["invalid phone"] } }).code, "CHAPA_INVALID_PHONE");
  assert.equal(mapChapaFailure(400, { errors: { amount: ["required"] } }).code, "CHAPA_INVALID_FIELDS");
  assert.equal(mapChapaFailure(400, { message: "User can't receive payments" }).code, "CHAPA_ACCOUNT_NOT_READY");
  assert.equal(mapChapaFailure(400, { message: "Incorrect header settings: content-type" }).code, "CHAPA_REQUEST_FORMAT_INVALID");
  assert.equal(mapChapaFailure(400, { message: "Invalid currency, currency is not supported" }).code, "CHAPA_INVALID_CURRENCY");
  assert.equal(mapChapaFailure(400, { message: "The subaccount id you provided isn't associated with this account" }).code, "CHAPA_SUBACCOUNT_INVALID");
  assert.equal(mapChapaFailure(400, { message: "Merchant's share of payment is not enough to cover transaction fee" }).code, "CHAPA_MERCHANT_FEE_INVALID");
  assert.equal(mapChapaFailure(400, { message: "The amount field must be a number." }).code, "CHAPA_INVALID_AMOUNT");
  assert.equal(mapChapaFailure(400, { message: "The email field must be no more than 50 characters long." }).code, "CHAPA_INVALID_FIELDS");
  assert.equal(mapChapaFailure(400, { message: "The customization.description may only contain letters, numbers, hyphens, underscores, spaces, and dots." }).code, "CHAPA_INVALID_CUSTOMIZATION");
  assert.equal(mapChapaFailure(400, { message: "Unknown provider rejection" }).reasonClass, "unclassified_400");
  assert.equal(mapChapaFailure(503, { message: "temporarily unavailable" }).retryAction, "same_reference");
});

test("duplicate references and provider rate limits require reconciliation, never a competing payment", () => {
  assert.equal(mapChapaFailure(400, { message: "Transaction reference has been used before" }).retryAction, "wait");
  assert.equal(mapChapaFailure(429, { message: "Too many requests" }).retryAction, "wait");
  assert.equal(mapChapaFailure(408, { message: "Request timeout" }).retryAction, "wait");
});

test("provider message normalization bounds deep, wide and cyclic input", () => {
  const cyclic: any = { message: "Safe message" };
  cyclic.details = cyclic;
  assert.equal(normalizeChapaMessage(cyclic), "Safe message");
  assert.ok(normalizeChapaMessage(Array.from({ length: 10000 }, () => "a".repeat(1000))).length <= 4096);
});

test("Chapa customization strings contain only documented characters", () => {
  const customization = createChapaCustomization("PAY-e983e59830544c46952ea8f19e8bd85e");
  assert.match(customization.title, /^[A-Za-z0-9_ .-]+$/);
  assert.match(customization.description, /^[A-Za-z0-9_ .-]+$/);
  assert.equal(customization.description, "Order 9E8BD85E");
  assert.equal(customization.title, "Restaurant");
  assert.equal(createChapaCustomization("PAY-ref", "Test").title, "Test");
  assert.equal(createChapaCustomization("PAY-ref", "A & B's Kitchen").title, "A B s Kitchen");
  assert.equal(createChapaCustomization("PAY-ref", "  ").title, "Restaurant");
});

test("never returns raw gateway messages as customer error text", () => {
  const error = mapChapaFailure(400, { message: { internal: "customer@example.com key=secret" } });
  assert.equal(error.message, "Chapa rejected this payment request. Check the checkout details and merchant payment settings, then try again.");
  assert.equal(error.message.includes("secret"), false);
});

test("provider diagnostics redact customer and payment data", () => {
  const hint = safeChapaDiagnostic(
    { message: "Invalid request for user@example.com phone 0912345678 tx PAY-123456 amount 125.50 https://private.example/path" },
    ["user@example.com", "0912345678", "PAY-123456", "125.50", "https://private.example/path"]
  );
  assert.match(hint, /Invalid request/);
  assert.equal(hint.includes("user@example.com"), false);
  assert.equal(hint.includes("0912345678"), false);
  assert.equal(hint.includes("PAY-123456"), false);
  assert.equal(hint.includes("125.50"), false);
  assert.equal(hint.includes("private.example"), false);
});
