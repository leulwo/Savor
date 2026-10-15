import { test } from "node:test";
import assert from "node:assert/strict";
import { chapaPhoneNumber } from "../chapa-phone";
import { checkoutValidationError, safeCheckoutFailure } from "../checkout-validation";

test("an unrelated HTTP 400 cannot masquerade as an invalid phone number", () => {
  assert.deepEqual(safeCheckoutFailure(Object.assign(new Error("restaurant unavailable"), { statusCode: 400 })), {
    code: "CHECKOUT_INVALID_REQUEST",
    error: "Review your checkout details and try again."
  });
});

test("actual invalid phones keep their dedicated actionable error", () => {
  assert.throws(() => chapaPhoneNumber("+254712345678"), error => {
    const failure = safeCheckoutFailure(error);
    assert.equal(failure.code, "CHECKOUT_INVALID_PHONE");
    assert.match(failure.error, /09 or 07/);
    assert.match(failure.error, /\+251/);
    return true;
  });
});

test("local order validation identifies the rejected detail and offers a next step", () => {
  const cases = [
    ["CHECKOUT_RESTAURANT_CLOSED", /opening hours/],
    ["CHECKOUT_ITEM_UNAVAILABLE", /choose another item/],
    ["CHECKOUT_VARIANT_UNAVAILABLE", /choose another option/],
    ["CHECKOUT_INVALID_QUANTITY", /whole number from 1 to 99/],
    ["CHECKOUT_PROMO_LIMIT_REACHED", /Remove it or use another code/],
    ["CHECKOUT_INVALID_PRICE", /Refresh the menu/],
    ["CHECKOUT_CART_EMPTY", /Add an item/],
    ["CHECKOUT_CART_TOO_LARGE", /50 or fewer/]
  ] as const;
  for (const [code, instruction] of cases) {
    const localError = checkoutValidationError(code);
    assert.equal(localError.statusCode, 400);
    const failure = safeCheckoutFailure(localError);
    assert.equal(failure.code, code);
    assert.match(failure.error, instruction);
    assert.doesNotMatch(failure.error, /phone number/);
  }
});

test("only approved messages reach customers even if an error carries provider or personal data", () => {
  const raw = "private@example.com secret-key provider internals";
  for (const code of ["CHECKOUT_ITEM_UNAVAILABLE", "UNEXPECTED_INTERNAL", "__proto__", "constructor"]) {
    const failure = safeCheckoutFailure({ statusCode: 400, code, message: raw });
    assert.equal(failure.error.includes(raw), false);
    assert.equal(failure.error.includes("secret-key"), false);
    assert.notEqual(failure.code, "CHECKOUT_INVALID_PHONE");
  }
  assert.equal(safeCheckoutFailure(new Error(raw)).code, "CHAPA_INITIALIZE_ERROR");
});

test("attempt conflicts retain their specific recovery instruction", () => {
  for (const code of ["PAYMENT_REQUEST_CHANGED", "PAYMENT_ATTEMPT_ENDED"] as const) {
    const failure = safeCheckoutFailure(checkoutValidationError(code, 409));
    assert.equal(failure.code, code);
    assert.match(failure.error, /new payment attempt/);
  }
  for (const code of ["PAYMENT_PREVIOUS_ATTEMPT_OPEN", "CHECKOUT_ACTIVE_ATTEMPT_LIMIT"] as const) {
    const failure = safeCheckoutFailure(checkoutValidationError(code, 409));
    assert.equal(failure.code, code);
    assert.match(failure.error, /Resume or cancel.*My Orders/);
  }
  const held = safeCheckoutFailure(checkoutValidationError("PAYMENT_RECONCILIATION_REQUIRED", 409));
  assert.equal(held.code, "PAYMENT_RECONCILIATION_REQUIRED");
  assert.match(held.error, /Do not pay again/);
});
