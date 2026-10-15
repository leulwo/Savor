import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalStore } from "../local-store";
import { installFirestoreMigration } from "../firestore-migration";

const PREFIX = "projects/test-project/databases/(default)/documents/";

test("legacy migration is unavailable unless explicitly enabled", async () => {
  const h = await harness({ enabled: false });
  try {
    // A disabled installer leaves the router untouched and cannot contact Firestore.
    const app = express();
    installFirestoreMigration(app, h.db, { projectId: "test-project", appRoot: h.appRoot, verifyToken: async () => null });
    assert.equal((app as any)._router, undefined);
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});

test("a cloud administrator cannot bypass current local administrator authorization", async () => {
  const h = await harness({ localAllowed: false });
  try {
    const result = await h.migrate();
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "FIRESTORE_MIGRATION_FORBIDDEN");
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});
function value(input: any): any {
  if (input === null) return { nullValue: null };
  if (typeof input === "string") return { stringValue: input };
  if (typeof input === "boolean") return { booleanValue: input };
  if (typeof input === "number") return { integerValue: String(input) };
  if (Array.isArray(input)) return { arrayValue: { values: input.map(value) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(input).map(([key, field]) => [key, value(field)])) } };
}
function cloudDoc(docPath: string, data: any): any {
  return { name: PREFIX + docPath, fields: Object.fromEntries(Object.entries(data).map(([key, field]) => [key, value(field)])) };
}

async function harness(options: { admin?: any; deny?: string; malformed?: string; pages?: boolean; slow?: boolean; enabled?: boolean; localAllowed?: boolean } = {}) {
  const appRoot = await mkdtemp(path.join(tmpdir(), "savory-migration-test-"));
  const db = createLocalStore(":memory:");
  const calls: string[] = [];
  const providerDocs = new Map<string, any>([
    ["admins/owner@example.com", options.admin || { role: "admin", active: true }],
    ["menu/current", { name: "Current cloud dish", price: 80 }],
    ["settings/checkout", { chapaMode: "test" }],
    ["orders/cloud-paid", { userId: "customer-b", paymentStatus: "completed", amount: 80 }],
    ["orders/local-paid", { userId: "customer-a", paymentStatus: "pending", amount: 80 }],
    ["orders/local-refunded", { userId: "customer-a", paymentStatus: "completed", amount: 80 }],
    ["users/owner-uid", { uid: "owner-uid", displayName: "Owner" }],
    ["carts/owner-uid", { userId: "owner-uid", items: [{ id: "current", quantity: 1 }] }],
    ["users/owner-uid/notifications/notice", { title: "Own notification", read: false }],
    ["users/customer-b/notifications/private", { title: "Private notification" }],
    ["carts/customer-b", { items: [{ id: "private" }] }]
  ]);
  let release: () => void = () => {};
  const paused = new Promise<void>(resolve => { release = resolve; });
  const app = express();
  app.use(express.json());
  installFirestoreMigration(app, db, {
    enabled: options.enabled ?? true,
    authorizeLocalAdmin: async actor => options.localAllowed !== false && actor.email?.toLowerCase() === "owner@example.com",
    projectId: "test-project", appRoot,
    verifyToken: async request => {
      const token = String(request.headers.authorization || "").replace(/^Bearer /, "");
      if (token === "owner") return { uid: "owner-uid", email: "OWNER@EXAMPLE.COM", email_verified: true };
      if (token === "unverified") return { uid: "owner-uid", email: "owner@example.com", email_verified: false };
      if (token === "customer") return { uid: "customer-b", email: "customer@example.com", email_verified: true };
      return null;
    },
    fetch: async (url, init) => {
      assert.ok(String((init?.headers as any)?.authorization).startsWith("Bearer "));
      const parsed = new URL(url);
      const docPath = decodeURIComponent(parsed.pathname.split("/documents/")[1]);
      calls.push(docPath);
      if (options.slow && docPath === "menu") await paused;
      if (docPath === options.deny) return new Response(JSON.stringify({ error: { message: "PRIVATE PROVIDER DETAILS TOKEN" } }), { status: 403 });
      if (docPath === options.malformed) return new Response("not-json", { status: 200 });
      if (!parsed.search) return providerDocs.has(docPath)
        ? Response.json(cloudDoc(docPath, providerDocs.get(docPath)))
        : new Response("", { status: 404 });
      const matches = [...providerDocs.entries()].filter(([key]) => key.startsWith(docPath + "/") && key.split("/").length === docPath.split("/").length + 1);
      if (options.pages && docPath === "menu") {
        if (!parsed.searchParams.get("pageToken")) return Response.json({ documents: matches.map(([key, data]) => cloudDoc(key, data)), nextPageToken: "second" });
        return Response.json({ documents: [cloudDoc("menu/second", { name: "Second cloud dish", createdAt: null })] });
      }
      return Response.json({ documents: matches.map(([key, data]) => cloudDoc(key, data)) });
    }
  });
  const server = await new Promise<Server>(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    appRoot, db, calls, providerDocs, release,
    async migrate(token = "owner", body: any = {}) {
      const response = await fetch(`${base}/api/database/migrate-firestore`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    },
    async status() { return await (await fetch(`${base}/api/database/migration/status`, { headers: { authorization: "Bearer owner" } })).json(); },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await rm(appRoot, { recursive: true, force: true }); }
  };
}

test("Firestore migration imports cloud data once, backs up local records and preserves ownership/payment truth", async () => {
  const h = await harness({ pages: true });
  try {
    await mkdir(path.join(h.appRoot, "data"));
    const sample = { id: "sample", name: "Old sample", category: "Mains", price: 12 };
    await writeFile(path.join(h.appRoot, "data", "db.json"), JSON.stringify({ menu: [sample] }));
    await h.db.doc("menu/sample").set(sample);
    await h.db.doc("categories/mains").set({ name: "Mains" });
    await h.db.doc("menu/edited").set({ name: "Locally edited dish", price: 95 });
    await h.db.doc("orders/legacy-unowned").set({ paymentStatus: "pending", amount: 12 });
    await h.db.doc("orders/local-paid").set({ userId: "customer-a", paymentStatus: "completed", amount: 80 });
    await h.db.doc("orders/local-refunded").set({ userId: "customer-a", paymentStatus: "refunded", amount: 80 });
    assert.deepEqual(await h.status(), { completed: false });
    const migrated = await h.migrate();
    assert.equal(migrated.status, 200);
    assert.equal(migrated.body.preservedPaymentDocuments, 2);
    assert.equal(migrated.body.removedBootstrapDocuments, 2);
    assert.equal((await h.db.doc("orders/local-paid").get()).data()?.paymentStatus, "completed");
    assert.equal((await h.db.doc("orders/local-refunded").get()).data()?.paymentStatus, "refunded");
    assert.equal((await h.db.doc("orders/cloud-paid").get()).data()?.userId, "customer-b");
    assert.equal((await h.db.doc("orders/legacy-unowned").get()).data()?.userId, undefined);
    assert.equal((await h.db.doc("menu/sample").get()).exists, false);
    assert.equal((await h.db.doc("menu/edited").get()).exists, true);
    assert.equal((await h.db.doc("menu/second").get()).exists, true);
    assert.equal((await h.db.doc("carts/owner-uid").get()).exists, true);
    assert.equal((await h.db.doc("carts/customer-b").get()).exists, false);
    assert.equal((await h.db.doc("users/customer-b/notifications/private").get()).exists, false);
    assert.ok(!h.calls.includes("carts") && !h.calls.includes("orderRequests") && !h.calls.includes("users/customer-b/notifications"));
    assert.deepEqual(migrated.body.excludedScopes, ["other_user_carts", "other_user_notifications", "backend_idempotency_records"]);
    assert.ok(!JSON.stringify(migrated.body).includes("Current cloud dish"));
    const backup = JSON.parse(await readFile(path.join(h.appRoot, "data", "backups", migrated.body.backupFilename), "utf8"));
    assert.ok(backup.records.some((document: any) => document.path === "menu/sample"));
    assert.deepEqual(await h.status(), { completed: true });
    h.providerDocs.set("menu/current", { name: "Changed after migration" });
    assert.equal((await h.migrate()).body.alreadyCompleted, true);
    assert.equal((await h.db.doc("menu/current").get()).data()?.name, "Current cloud dish");
  } finally { await h.close(); }
});

test("customer, unverified email and inactive/non-admin cloud account cannot migrate", async () => {
  const h = await harness();
  try {
    for (const token of ["customer", "unverified", "missing"]) {
      const response = await h.migrate(token);
      assert.equal(response.status, token === "missing" ? 401 : 403);
      assert.equal((await h.db.doc("_local/firestore-import-v1").get()).exists, false);
    }
    for (const admin of [{ role: "staff", active: true }, { role: "admin", active: false }, { role: "admin", disabled: true }, { role: "admin", status: "disabled" }]) {
      h.providerDocs.set("admins/owner@example.com", admin);
      assert.equal((await h.migrate()).status, 403);
    }
    assert.equal(h.db.exportDocuments().length, 0);
  } finally { await h.close(); }
});

test("a denied required collection aborts without partial import or leaking provider messages", async () => {
  const h = await harness({ deny: "orders" });
  try {
    await h.db.doc("menu/original").set({ name: "Original" });
    const before = h.db.exportDocuments();
    const result = await h.migrate();
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "FIRESTORE_MIGRATION_FORBIDDEN");
    assert.ok(!JSON.stringify(result.body).includes("PRIVATE PROVIDER"));
    assert.deepEqual(h.db.exportDocuments(), before);
    await assert.rejects(readdir(path.join(h.appRoot, "data", "backups")));
  } finally { await h.close(); }
});

test("malformed remote JSON and client-controlled scopes are rejected atomically", async () => {
  const h = await harness({ malformed: "menu" });
  try {
    assert.equal((await h.migrate("owner", { collections: ["orders"] })).status, 400);
    const failed = await h.migrate();
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, "FIRESTORE_MIGRATION_INVALID_RESPONSE");
    assert.equal(h.db.exportDocuments().length, 0);
  } finally { await h.close(); }
});

test("concurrent migration callers cannot create competing imports", async () => {
  const h = await harness({ slow: true });
  try {
    const pending = h.migrate();
    for (let count = 0; count < 100 && !h.calls.includes("menu"); count++) await new Promise(resolve => setTimeout(resolve, 5));
    const second = await h.migrate();
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "FIRESTORE_MIGRATION_IN_PROGRESS");
    h.release();
    assert.equal((await pending).status, 200);
    assert.equal((await readdir(path.join(h.appRoot, "data", "backups"))).length, 1);
  } finally { h.release(); await h.close(); }
});
