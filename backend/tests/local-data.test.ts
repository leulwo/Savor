import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "../local-store";
import { initializeLocalData } from "../local-data";

test("startup imports legacy records once without changing payment or ownership and survives restart", async () => {
  const appRoot = mkdtempSync(join(tmpdir(), "savory-migration-"));
  const sqlitePath = join(appRoot, "data", "app.sqlite");
  mkdirSync(join(appRoot, "data"));
  const pendingOrder = { id: "pending-order", userId: "customer-owner", amount: 99, paymentStatus: "pending", paymentAttemptStatus: "reconciling", paymentMethod: "chapa", leaseExpiresAt: 123456, txRef: "PAY-kept", statusHistory: [{ status: "pending", at: "2026-10-01T12:00:00Z" }] };
  const paidOrder = { id: "paid-order", userId: "paid-owner", amount: 125, paymentStatus: "completed", paymentAttemptStatus: "success", paymentVerifiedAt: "2026-10-01T12:01:00Z", status: "pending", chapaAmount: 125 };
  const legacy = {
    orders: [pendingOrder, paidOrder, { id: "existing-order", userId: "legacy-owner", paymentStatus: "pending", amount: 1 }],
    menu: [{ id: "dish", name: "Dinner", price: 99, category: "Dinner", variations: [{ id: "regular", price: 99 }] }],
    settings: { global: { restaurantName: "Existing Restaurant", serviceTaxPercent: 5, enableCOD: false } },
    users: { "customer-owner": { uid: "customer-owner", email: "customer@example.com", preferences: { marketing: false } } },
    admins: { "owner@example.com": { role: "admin", active: true, displayName: "Owner" } },
    roles: { admin: { name: "Owner", permissions: { "orders.view": true } } }
  };
  writeFileSync(join(appRoot, "data", "db.json"), JSON.stringify(legacy));
  let db = createLocalStore(sqlitePath);
  const existing = { userId: "current-owner", paymentStatus: "completed", amount: 300, paymentVerifiedAt: "already-verified" };
  try {
    await db.doc("orders/existing-order").create(existing);
    await initializeLocalData(db, appRoot);
    assert.deepEqual((await db.doc("orders/pending-order").get()).data(), pendingOrder);
    assert.deepEqual((await db.doc("orders/paid-order").get()).data(), paidOrder);
    assert.deepEqual((await db.doc("orders/existing-order").get()).data(), existing);
    assert.deepEqual((await db.doc("admins/owner@example.com").get()).data(), legacy.admins["owner@example.com"]);
    assert.deepEqual((await db.doc("users/customer-owner").get()).data(), legacy.users["customer-owner"]);
    assert.deepEqual((await db.doc("settings/global").get()).data(), legacy.settings.global);
    assert.deepEqual((await db.doc("settings/checkout").get()).data(), legacy.settings.global);
    assert.equal((await db.doc("categories/dinner").get()).get("name"), "Dinner");
    const migration = (await db.doc("_local/migration-v1").get()).data();
    assert.equal(migration?.schemaVersion, 1);
    const revision = db.currentRevision();
    db.close();
    legacy.orders[0] = { ...pendingOrder, userId: "tampered-owner", paymentStatus: "completed" };
    writeFileSync(join(appRoot, "data", "db.json"), JSON.stringify(legacy));
    db = createLocalStore(sqlitePath);
    await initializeLocalData(db, appRoot);
    assert.deepEqual((await db.doc("orders/pending-order").get()).data(), pendingOrder);
    assert.deepEqual((await db.doc("orders/paid-order").get()).data(), paidOrder);
    assert.deepEqual((await db.doc("orders/existing-order").get()).data(), existing);
    assert.deepEqual((await db.doc("_local/migration-v1").get()).data(), migration);
    assert.equal(db.currentRevision(), revision);
  } finally { db.close(); rmSync(appRoot, { recursive: true, force: true }); }
});

test("fresh startup seeds checkout settings without inventing customer orders", async () => {
  const appRoot = mkdtempSync(join(tmpdir(), "savory-fresh-"));
  const db = createLocalStore(":memory:");
  try {
    await initializeLocalData(db, appRoot);
    assert.equal((await db.doc("settings/global").get()).get("restaurantName"), "");
    assert.deepEqual((await db.doc("settings/checkout").get()).data(), (await db.doc("settings/global").get()).data());
    assert.equal((await db.collection("orders").get()).size, 0);
    assert.equal((await db.collection("menu").get()).size, 0);
    const revision = db.currentRevision();
    await initializeLocalData(db, appRoot);
    assert.equal(db.currentRevision(), revision);
  } finally { db.close(); rmSync(appRoot, { recursive: true, force: true }); }
});

test("an invalid legacy record rolls back migration and preserves existing verified payments", async () => {
  const appRoot = mkdtempSync(join(tmpdir(), "savory-invalid-migration-"));
  mkdirSync(join(appRoot, "data"));
  writeFileSync(join(appRoot, "data", "db.json"), JSON.stringify({ menu: [{ id: "dish", price: 50 }], orders: [{ id: "invalid/order", paymentStatus: "completed" }] }));
  const db = createLocalStore(":memory:");
  try {
    await db.doc("orders/existing").create({ userId: "owner", paymentStatus: "completed" });
    const revision = db.currentRevision();
    await assert.rejects(initializeLocalData(db, appRoot), /Invalid orders record/);
    assert.equal((await db.doc("_local/migration-v1").get()).exists, false);
    assert.equal((await db.doc("menu/dish").get()).exists, false);
    assert.equal((await db.doc("settings/global").get()).exists, false);
    assert.equal((await db.doc("orders/existing").get()).get("paymentStatus"), "completed");
    assert.equal(db.currentRevision(), revision);
  } finally { db.close(); rmSync(appRoot, { recursive: true, force: true }); }
});
