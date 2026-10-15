import { test } from "node:test";
import assert from "node:assert/strict";
import { chapaPhoneNumber, CHECKOUT_PHONE_ERROR } from "../chapa-phone";

test("normalizes both documented Ethiopian mobile prefixes to Chapa local form", () => {
  for (const prefix of ["7", "9"]) {
    const subscriber = prefix + "12345678";
    for (const phone of ["0" + subscriber, subscriber, "+251" + subscriber, "251" + subscriber, "00251" + subscriber]) {
      assert.equal(chapaPhoneNumber(phone), "0" + subscriber);
    }
  }
});

test("accepts presentation formatting and common Unicode phone input", () => {
  for (const phone of [
    " 091 234 5678 ",
    "+251 (91) 234-5678",
    "00251.91.234.5678",
    "09\u00a0123\u202f45678",
    "091\u2011234\u20115678",
    "\u200e+251\u200f912345678",
    "٠٩١٢٣٤٥٦٧٨",
    "۰۹۱۲۳۴۵۶۷۸",
    "＋２５１（９１）２３４－５６７８"
  ]) assert.equal(chapaPhoneNumber(phone), "0912345678");
});

test("allows omission of the optional hosted checkout phone", () => {
  for (const value of [undefined, null, "", " \n\t ", "\u200e"]) {
    assert.equal(chapaPhoneNumber(value), undefined);
  }
});

test("rejects invalid length, wrong country, nonmobile numbers and hidden text", () => {
  for (const value of [
    "091234567", "09123456789", "0612345678", "0112345678",
    "+254912345678", "+2510912345678", "000251912345678",
    "0912345678 ext 1", "0912345678x1", "phone 0912345678",
    "09/12345678", "++251912345678", "09\u000012345678",
    "09(12345678", "09)12345678", "09((123))45678", "091()2345678",
    "+", "()", 912345678, false, {}, ["0912345678"], " ".repeat(81)
  ]) {
    assert.throws(() => chapaPhoneNumber(value), error => {
      const failure = error as Error & { code?: string; statusCode?: number };
      assert.equal(failure.message, CHECKOUT_PHONE_ERROR);
      assert.equal(failure.code, "CHECKOUT_INVALID_PHONE");
      assert.equal(failure.statusCode, 400);
      return true;
    });
  }
});
