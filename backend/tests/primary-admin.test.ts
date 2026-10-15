import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalStore } from "../local-store";
import { parsePrimaryAdminEmail, syncPrimaryAdmin, resolveLocalStaffPermissions, isPrimaryAdminProtectedPath } from "../primary-admin";

test("primary email config is normalized and malformed account lists fail closed", () => {
  assert.equal(parsePrimaryAdminEmail("  OWNER@Example.com  "), "owner@example.com");
  assert.equal(parsePrimaryAdminEmail(undefined), "");
  for (const value of ["owner", "owner@example.com,second@example.com", "owner@example.com,", "owner@example.com\nsecond@example.com", "owner@example.com/extra", ["owner@example.com"]]) {
    assert.throws(() => parsePrimaryAdminEmail(value), /single valid email/);
  }
});

test("environment bootstrap adopts the configured owner and supplies portal role permissions", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("admins/owner@example.com").set({ role: "admin", createdAt: "original-created-at" });
    await syncPrimaryAdmin(db, "OWNER@EXAMPLE.COM");
    const record = (await db.doc("admins/owner@example.com").get()).data();
    assert.equal(record?.managedBy, "PRIMARY_ADMIN_EMAIL");
    assert.equal(record?.primaryAdmin, true);
    assert.equal(record?.active, true);
    assert.equal(record?.createdAt, "original-created-at");
    assert.equal((await db.doc("roles/admin").get()).data()?.permissions["settings.edit"], true);
    await syncPrimaryAdmin(db, "owner@example.com");
    assert.equal((await db.collection("admins").get()).size, 1);
  } finally { db.close(); }
});

test("changing the primary revokes the old derived grant and preserves unrelated team accounts", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("admins/staff@example.com").set({ role: "kitchen", active: true });
    await db.doc("admins/independent@example.com").set({ role: "admin", active: true });
    await db.doc("roles/kitchen").set({ permissions: { "kds.view": true } });
    await syncPrimaryAdmin(db, "first@example.com");
    await syncPrimaryAdmin(db, "second@example.com");
    assert.equal((await db.doc("admins/first@example.com").get()).exists, false);
    assert.equal(await resolveLocalStaffPermissions(db, "first@example.com", "second@example.com"), null);
    assert.equal((await resolveLocalStaffPermissions(db, "second@example.com", "second@example.com"))?.role, "admin");
    assert.equal((await resolveLocalStaffPermissions(db, "staff@example.com", "second@example.com"))?.permissions["kds.view"], true);
    assert.equal((await resolveLocalStaffPermissions(db, "independent@example.com", "second@example.com"))?.role, "admin");
  } finally { db.close(); }
});

test("removing primary config revokes derived records without deleting ordinary owners", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("admins/independent@example.com").set({ role: "admin", active: true });
    await syncPrimaryAdmin(db, "owner@example.com");
    await syncPrimaryAdmin(db, "");
    assert.equal((await db.doc("admins/owner@example.com").get()).exists, false);
    assert.equal((await db.doc("admins/independent@example.com").get()).exists, true);
  } finally { db.close(); }
});

test("stale environment-managed rows cannot grant access after primary rotation", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("admins/old@example.com").set({ role: "admin", active: true, managedBy: "PRIMARY_ADMIN_EMAIL" });
    assert.equal(await resolveLocalStaffPermissions(db, "old@example.com", "new@example.com"), null);
    assert.equal(await resolveLocalStaffPermissions(db, "old@example.com", ""), null);
    assert.equal((await resolveLocalStaffPermissions(db, "new@example.com", "new@example.com"))?.role, "admin");
  } finally { db.close(); }
});

test("business clear preserves only configured primary login and the full access role", () => {
  assert.equal(isPrimaryAdminProtectedPath("admins/owner@example.com", "owner@example.com"), true);
  assert.equal(isPrimaryAdminProtectedPath("roles/admin", "owner@example.com"), true);
  assert.equal(isPrimaryAdminProtectedPath("admins/staff@example.com", "owner@example.com"), false);
  assert.equal(isPrimaryAdminProtectedPath("menu/dish", "owner@example.com"), false);
  assert.equal(isPrimaryAdminProtectedPath("roles/admin", ""), false);
});

test("malformed or disabled imported staff grants fail closed", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("roles/kitchen").set({ permissions: { "kds.view": true, "settings.edit": "true", "future.unknown": true } });
    for (const patch of [{ status: " disabled " }, { active: "false" }, { disabled: "false" }, { status: {} }, { role: { name: "admin" } }, { role: "../admin" }]) {
      await db.doc("admins/staff@example.com").set({ role: "kitchen", active: true, ...patch });
      assert.equal(await resolveLocalStaffPermissions(db, "staff@example.com", ""), null);
    }
    await db.doc("admins/staff@example.com").set({ role: "kitchen", active: true });
    assert.deepEqual((await resolveLocalStaffPermissions(db, "staff@example.com", ""))?.permissions, { "kds.view": true });
    await db.doc("roles/kitchen").update({ status: " DISABLED " });
    assert.equal(await resolveLocalStaffPermissions(db, "staff@example.com", ""), null);
    assert.equal(await resolveLocalStaffPermissions(db, "bad/path@example.com", ""), null);
  } finally { db.close(); }
});
