import test from "node:test";
import assert from "node:assert/strict";
import { redactServerSecrets, validatedCheckoutSettings, normalizeSettingsFields, safeAuthRedirect, mergeFirebaseConfiguration } from "../config-security";

test("browser settings and exports omit nested legacy server credentials", () => {
  const original = { restaurantName: "Test", shipdayApiKey: "private", chapa_secret: "private", integration: { apiKey: "private", refreshToken: "private", enabled: true }, rows: [{ password: "private", name: "Keep" }] };
  assert.deepEqual(redactServerSecrets(original), { restaurantName: "Test", integration: { enabled: true }, rows: [{ name: "Keep" }] });
  assert.equal(original.shipdayApiKey, "private");
});

test("generic settings commits cannot bypass typed checkout fields", () => {
  assert.deepEqual(normalizeSettingsFields({ restaurantName: "Test", serviceTaxPercent: "15", isOpen: false }), { restaurantName: "Test", serviceTaxPercent: 15, isOpen: false });
  for (const value of [{ "isOpen.value": true }, { restaurantName: {} }, { isOpen: { __op: "delete" } }, { enableChatbot: "false" }, { serviceTaxPercent: [] }]) assert.throws(() => normalizeSettingsFields(value));
});

test("business display settings cannot bypass scalar validation through dotted updates", () => {
  for (const key of ["restaurantName", "businessEmail", "businessPhone", "businessAddress"]) {
    for (const value of [{ [`${key}.value`]: "Nested replacement" }, { [key]: "Valid scalar", [`${key}.value`]: "Nested replacement" }]) {
      assert.throws(() => normalizeSettingsFields(value), (error: any) => error.status === 400 && error.code === "DATABASE_INVALID_REQUEST");
    }
  }
  const settings = { restaurantName: "Test", businessEmail: "restaurant@example.com", businessPhone: "0912345678", businessAddress: "Restaurant address", updatedAt: { __op: "serverTimestamp" } };
  assert.deepEqual(normalizeSettingsFields(settings), settings);
});

test("Firebase helper redirects cannot rewrite lookalike domains into app URLs", () => {
  const upstream = "https://fixture.firebaseapp.com";
  const origin = "https://restaurant.example";
  assert.equal(safeAuthRedirect("/__/auth/handler?state=fixture", upstream, origin), `${origin}/__/auth/handler?state=fixture`);
  assert.equal(safeAuthRedirect("https://accounts.google.com/o/oauth2/auth", upstream, origin), "https://accounts.google.com/o/oauth2/auth");
  for (const value of ["https://fixture.firebaseapp.com.evil.example", "https://accounts.google.com.evil.example", "javascript:alert(1)", "https://fixture.firebaseapp.com@evil.example", "//evil.example"]) assert.equal(safeAuthRedirect(value, upstream, origin), null);
});

test("runtime Firebase project configuration takes precedence over fallback files", () => {
  assert.deepEqual(mergeFirebaseConfiguration({ projectId: "old", authDomain: "old.firebaseapp.com", apiKey: "public" }, { projectId: "configured", authDomain: "" }), { projectId: "configured", authDomain: "old.firebaseapp.com", apiKey: "public" });
});

test("checkout settings use bounded finite primitives and retain partial updates", () => {
  assert.deepEqual(validatedCheckoutSettings({ serviceTaxPercent: "15", flatFeeETB: 0, enableCOD: false, openTime: "09:00" }), { serviceTaxPercent: 15, flatFeeETB: 0, enableCOD: false, openTime: "09:00" });
  for (const value of [{ serviceTaxPercent: -1 }, { serviceTaxPercent: Infinity }, { flatFeeETB: [] }, { isOpen: "false" }, { openTime: "12:99" }, { closeTime: {} }, { shipdayApiKey: "private" }, { shipdayPickupMinutes: 1.5 }]) {
    assert.throws(() => validatedCheckoutSettings(value), (error: any) => error.statusCode === 400);
  }
});
