import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { installDatabaseApi } from "../database-api";
import { createLocalStore } from "../local-store";
import { syncPrimaryAdmin, resolveLocalStaffPermissions } from "../primary-admin";

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(primaryEmail?: string) {
  const db = createLocalStore(":memory:");
  await db.doc("menu/dish").set({ name: "Dinner", price: 55, isActive: true, variations: [{ id: "regular", name: "Regular", price: 55, isAvailable: true }] });
  await db.doc("orders/own").set({ userId: "user-a", paymentStatus: "pending", amount: 55, customerAddress: "PRIVATE-ADDRESS-A" });
  await db.doc("orders/other").set({ userId: "user-b", paymentStatus: "completed", amount: 90, customerAddress: "PRIVATE-ADDRESS-B" });
  await db.doc("promoCodes/SAVE").set({ discountPercent: 10, usageCount: 1, maxUses: 5, isActive: true });
  await db.doc("chat_messages/own").set({ userId: "user-a", conversationId: "conversation-a", role: "user", text: "Hello" });
  await db.doc("chat_messages/other").set({ userId: "user-b", conversationId: "conversation-b", role: "user", text: "Private chat" });
  await db.doc("roles/limited").set({ name: "Limited", permissions: { "menu.editPrice": true } });
  await db.doc("users/user-a").set({ uid: "user-a", displayName: "Customer A", email: "a@example.com" });
  await db.doc("admins/owner@example.com").set({ role: "admin", active: true });
  await db.doc("admins/backup@example.com").set({ role: "admin", active: true });
  if (primaryEmail) await syncPrimaryAdmin(db, primaryEmail);
  const actors: Record<string, { uid: string; email: string; email_verified: boolean }> = {
    customer: { uid: "user-a", email: "a@example.com", email_verified: true },
    other: { uid: "user-b", email: "b@example.com", email_verified: true },
    staff: { uid: "staff-a", email: "staff@example.com", email_verified: true },
    unverified: { uid: "staff-b", email: "unverified@example.com", email_verified: false },
    chatstaff: { uid: "staff-chat", email: "chatstaff@example.com", email_verified: true },
    manager: { uid: "staff-manager", email: "manager@example.com", email_verified: true },
    editor: { uid: "staff-editor", email: "editor@example.com", email_verified: true },
    admin: { uid: "admin-a", email: "owner@example.com", email_verified: true }
  };
  const app = express();
  app.use(express.json({ strict: false }));
  installDatabaseApi(app, db, {
    verifyToken: async (req: any) => {
      const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
      return actors[token] || null;
    },
    resolveStaffPermissions: async (email: string) => {
      if (primaryEmail && email === primaryEmail) return resolveLocalStaffPermissions(db, email, primaryEmail);
      if (email === "owner@example.com") return { role: "admin", permissions: {} };
      if (email === "chatstaff@example.com") return { role: "staff", permissions: { "chat.view": true, "chat.reply": true } };
      if (email === "manager@example.com") return { role: "manager", permissions: { "roles.edit": true, "promos.manage": true, "menu.editPrice": true } };
      if (email === "editor@example.com") return { role: "staff", permissions: { "menu.edit": true } };
      if (["staff@example.com", "unverified@example.com"].includes(email)) {
        return { role: "staff", permissions: { "menu.editPrice": true, "orders.view": true, "promos.view": true } };
      }
      return null;
    },
    primaryAdminEmail: primaryEmail
  });
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(route: string, body: unknown, token?: string) {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() as any };
  }
  return {
    db, base, request,
    query: (path: string, token?: string, filters: any[] = [], kind = "collection") => request("/api/database/query", { path, kind, filters, orders: [] }, token),
    commit: (writes: unknown[], token?: string, preconditions?: unknown[]) => request("/api/database/commit", { writes, ...(preconditions ? { preconditions } : {}) }, token),
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    }
  };
}

async function withHarness(callback: (instance: Harness) => Promise<void>): Promise<void> {
  const instance = await harness();
  try { await callback(instance); }
  finally { await instance.close(); }
}

test("anonymous customers can read public menu data but invalid credentials are actionable", async () => {
  await withHarness(async api => {
    const menu = await api.query("menu");
    assert.equal(menu.status, 200);
    assert.deepEqual(menu.body.docs.map((doc: any) => doc.id), ["dish"]);
    assert.equal(menu.body.docs[0].data.name, "Dinner");
    const invalid = await api.query("menu", "invalid-token");
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.code, "AUTH_SESSION_EXPIRED");
  });
});

test("anonymous users cannot enumerate private user profiles", async () => {
  await withHarness(async api => {
    for (const [path, kind] of [["users", "collection"], ["users/user-a", "document"]]) {
      const result = await api.query(path, undefined, [], kind);
      assert.equal(result.status, 403);
      assert.equal(result.body.code, "DATABASE_FORBIDDEN");
      assert.equal(JSON.stringify(result.body).includes("a@example.com"), false);
    }
    assert.equal((await api.query("users/user-a", "customer", [], "document")).status, 200);
  });
});

test("settings queries redact legacy credentials for staff while preserving the public settings projection", async () => {
  await withHarness(async api => {
    await api.db.doc("settings/global").set({
      restaurantName: "Test", logoUrl: "/logo.png", enableCOD: true,
      shipdayApiKey: "PRIVATE_SHIPDAY_KEY", CHAPA_SECRET_KEY: "PRIVATE_CHAPA_KEY",
      privateConfiguration: {
        region: "safe-region", accessToken: "PRIVATE_ACCESS_TOKEN",
        entries: [{ label: "Safe label", refresh_token: "PRIVATE_REFRESH_TOKEN" }]
      }
    });
    const publicResult = await api.query("settings/global", undefined, [], "document");
    assert.equal(publicResult.status, 200);
    assert.deepEqual(publicResult.body.data, { restaurantName: "Test", logoUrl: "/logo.png", enableCOD: true });
    for (const result of [
      await api.query("settings/global", "admin", [], "document"),
      await api.query("settings", "admin")
    ]) {
      assert.equal(result.status, 200);
      assert.equal(JSON.stringify(result.body).includes("PRIVATE_"), false);
      const settings = result.body.data || result.body.docs[0].data;
      assert.equal(settings.restaurantName, "Test");
      assert.deepEqual(settings.privateConfiguration, { region: "safe-region", entries: [{ label: "Safe label" }] });
    }
    assert.equal((await api.db.doc("settings/global").get()).get("shipdayApiKey"), "PRIVATE_SHIPDAY_KEY");
  });
});

test("settings commits reject dotted replacements of publicly rendered business primitives atomically", async () => {
  await withHarness(async api => {
    const initial = { restaurantName: "Test", businessEmail: "restaurant@example.com", businessPhone: "0912345678", businessAddress: "Restaurant address", isOpen: true };
    await api.db.doc("settings/global").set(initial);
    for (const key of Object.keys(initial)) {
      const result = await api.commit([
        { type: "update", path: "settings/global", data: { [`${key}.value`]: "Nested replacement" } },
        { type: "set", path: "settings/should-not-exist", data: { restaurantName: "Rejected batch" } }
      ], "admin");
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "DATABASE_INVALID_REQUEST");
      assert.deepEqual((await api.db.doc("settings/global").get()).data(), initial);
      assert.equal((await api.db.doc("settings/should-not-exist").get()).exists, false);
    }
    const result = await api.commit([{ type: "update", path: "settings/global", data: { restaurantName: "Updated restaurant", serviceTaxPercent: "12.5" } }], "admin");
    assert.equal(result.status, 200);
    assert.equal((await api.db.doc("settings/global").get()).get("restaurantName"), "Updated restaurant");
    assert.equal((await api.db.doc("settings/global").get()).get("serviceTaxPercent"), 12.5);
  });
});

test("database collection API rejects results beyond its staff and public limits", async () => {
  await withHarness(async api => {
    const result = await api.request("/api/database/query", { path: "menu", kind: "collection", limit: 5001 }, "admin");
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "DATABASE_INVALID_REQUEST");
    assert.equal((await api.request("/api/database/query", { path: "menu", kind: "collection", limit: 5000 }, "admin")).status, 200);
    assert.equal((await api.request("/api/database/query", { path: "menu", kind: "collection", limit: 1001 })).status, 400);
  });
});

test("customers can read only their own order documents and explicitly scoped order queries", async () => {
  await withHarness(async api => {
    const own = await api.query("orders/own", "customer", [], "document");
    assert.equal(own.status, 200);
    assert.equal(own.body.data.userId, "user-a");
    const other = await api.query("orders/other", "customer", [], "document");
    assert.equal(other.status, 403);
    assert.equal(other.body.code, "DATABASE_FORBIDDEN");
    assert.equal((await api.query("orders", "customer")).status, 403);
    const scoped = await api.query("orders", "customer", [{ field: "userId", op: "==", value: "user-a" }]);
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.body.docs.map((doc: any) => doc.id), ["own"]);
    assert.equal((await api.query("orders", "customer", [{ field: "userId", op: "==", value: "user-b" }])).status, 403);
  });
});

test("customers cannot create forged paid orders or alter stored payment truth", async () => {
  await withHarness(async api => {
    for (const write of [
      { type: "set", path: "orders/forged", data: { userId: "user-a", paymentStatus: "completed", amount: 1 } },
      { type: "update", path: "orders/own", data: { paymentStatus: "completed" } },
      { type: "delete", path: "orders/own" }
    ]) {
      const result = await api.commit([write], "customer");
      assert.equal(result.status, 403);
      assert.equal(result.body.code, "DATABASE_FORBIDDEN");
    }
    assert.equal((await api.db.doc("orders/forged").get()).exists, false);
    assert.equal((await api.db.doc("orders/own").get()).get("paymentStatus"), "pending");
  });
});

test("cart mutations are restricted to the authenticated owner", async () => {
  await withHarness(async api => {
    const own = await api.commit([{ type: "set", path: "carts/user-a", data: { items: [{ id: "dish", quantity: 2 }] } }], "customer");
    assert.equal(own.status, 200);
    assert.equal((await api.query("carts/user-a", "customer", [], "document")).body.data.items[0].quantity, 2);
    const other = await api.commit([{ type: "set", path: "carts/user-b", data: { items: [] } }], "customer");
    assert.equal(other.status, 403);
    assert.equal((await api.db.doc("carts/user-b").get()).exists, false);
    assert.equal((await api.query("carts/user-a", "other", [], "document")).status, 403);
    assert.equal((await api.query("carts", "customer")).status, 403);
  });
});

test("staff menu permissions have field scope and require verified email", async () => {
  await withHarness(async api => {
    assert.equal((await api.commit([{ type: "update", path: "menu/dish", data: { price: 60 } }], "staff")).status, 200);
    assert.equal((await api.commit([{ type: "update", path: "menu/dish", data: { name: "Unauthorized edit" } }], "staff")).status, 403);
    assert.equal((await api.commit([{ type: "set", path: "menu/dish", data: { price: 60 } }], "staff")).status, 403);
    assert.equal((await api.commit([{ type: "update", path: "menu/dish", data: { price: 70 } }], "unverified")).status, 403);
    assert.equal((await api.query("orders", "staff")).status, 200);
    assert.equal((await api.query("orders", "unverified")).status, 403);
    assert.equal((await api.db.doc("menu/dish").get()).get("price"), 60);
    assert.equal((await api.db.doc("menu/dish").get()).get("name"), "Dinner");
  });
});

test("one unauthorized batch operation rejects every operation atomically", async () => {
  await withHarness(async api => {
    const result = await api.commit([
      { type: "set", path: "carts/user-a", data: { items: [{ id: "dish", quantity: 1 }] } },
      { type: "update", path: "orders/own", data: { paymentStatus: "completed" } }
    ], "customer");
    assert.equal(result.status, 403);
    assert.equal((await api.db.doc("carts/user-a").get()).exists, false);
    assert.equal((await api.db.doc("orders/own").get()).get("paymentStatus"), "pending");
  });
});

test("content editors cannot alter variant prices without the price permission", async () => {
  await withHarness(async api => {
    const variant = { id: "regular", name: "Regular", price: 55, isAvailable: true };
    assert.equal((await api.commit([{ type: "update", path: "menu/dish", data: { variations: [{ ...variant, price: 1 }] } }], "editor")).status, 403);
    assert.equal((await api.db.doc("menu/dish").get()).get("variations")[0].price, 55);
    assert.equal((await api.commit([{ type: "update", path: "menu/dish", data: { variations: [{ ...variant, name: "Updated name" }] } }], "editor")).status, 200);
  });
});

test("customer chat permits own messages while rejecting forged staff replies and cross-user messages", async () => {
  await withHarness(async api => {
    const message = { userId: "user-a", conversationId: "conversation-a", role: "user", text: "Can I order?", customerName: "Customer A", createdAt: { __op: "serverTimestamp" } };
    assert.equal((await api.commit([{ type: "set", path: "chat_messages/new", data: message }], "customer")).status, 200);
    assert.equal((await api.commit([{ type: "set", path: "chat_messages/forged", data: { ...message, role: "model" } }], "customer")).status, 403);
    assert.equal((await api.commit([{ type: "set", path: "chat_messages/cross", data: { ...message, userId: "user-b" } }], "customer")).status, 403);
    assert.equal((await api.commit([{ type: "update", path: "chat_messages/new", data: { role: "model" } }], "customer")).status, 403);
    const own = await api.query("chat_messages", "customer", [{ field: "userId", op: "==", value: "user-a" }]);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.docs.map((doc: any) => doc.id).sort(), ["new", "own"]);
    assert.equal((await api.query("chat_messages", "customer")).status, 403);
    assert.equal((await api.db.doc("chat_messages/forged").get()).exists, false);
  });
});

test("authorized staff chat replies work with the existing UI payload and stay with the conversation owner", async () => {
  await withHarness(async api => {
    const reply = { conversationId: "conversation-a", role: "model", text: "Your order is ready.", senderName: "Staff", createdAt: { __op: "serverTimestamp" } };
    assert.equal((await api.commit([{ type: "set", path: "chat_messages/reply", data: reply }], "chatstaff")).status, 200);
    const stored = (await api.db.doc("chat_messages/reply").get()).data()!;
    assert.equal(stored.userId, "user-a");
    assert.equal(stored.role, "model");
    assert.equal((await api.commit([{ type: "set", path: "chat_messages/unprivileged", data: reply }], "staff")).status, 403);
  });
});

test("a customer cannot insert a message into another customer's conversation", async () => {
  await withHarness(async api => {
    const result = await api.commit([{ type: "set", path: "chat_messages/collision", data: { userId: "user-a", conversationId: "conversation-b", role: "user", text: "Injected message" } }], "customer");
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "DATABASE_FORBIDDEN");
    assert.equal((await api.db.doc("chat_messages/collision").get()).exists, false);
  });
});

test("simultaneous customers cannot claim the same new conversation", async () => {
  await withHarness(async api => {
    const responses = await Promise.all([
      api.commit([{ type: "set", path: "chat_messages/race-a", data: { userId: "user-a", conversationId: "new-conversation", role: "user", text: "Customer A" } }], "customer"),
      api.commit([{ type: "set", path: "chat_messages/race-b", data: { userId: "user-b", conversationId: "new-conversation", role: "user", text: "Customer B" } }], "other")
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 403]);
    assert.equal((await api.db.collection("chat_messages").where("conversationId", "==", "new-conversation").get()).size, 1);
  });
});

test("promotion counters cannot be forged by customers or staff with read access", async () => {
  await withHarness(async api => {
    for (const token of ["customer", "staff", "manager"]) {
      const result = await api.commit([{ type: "update", path: "promoCodes/SAVE", data: { usageCount: { __op: "increment", amount: -1 } } }], token);
      assert.equal(result.status, 403);
      assert.equal(result.body.code, "DATABASE_FORBIDDEN");
    }
    assert.equal((await api.query("promoCodes", "staff")).status, 200);
    assert.equal((await api.db.doc("promoCodes/SAVE").get()).get("usageCount"), 1);
    assert.equal((await api.commit([{ type: "update", path: "promoCodes/SAVE", data: { "usageCount.nested": 0 } }], "manager")).status, 403);
    assert.equal((await api.db.doc("promoCodes/SAVE").get()).get("usageCount"), 1);
  });
});

test("staff role managers cannot use dotted field paths to grant stronger permissions", async () => {
  await withHarness(async api => {
    const result = await api.commit([{ type: "update", path: "roles/limited", data: { "permissions.settings.edit": true } }], "manager");
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "DATABASE_FORBIDDEN");
    assert.equal((await api.db.doc("roles/limited").get()).get("permissions.settings.edit"), undefined);
  });
});

test("stale document versions reject the entire transaction", async () => {
  await withHarness(async api => {
    await api.db.doc("carts/user-a").set({ items: [] });
    const initial = await api.query("carts/user-a", "customer", [], "document");
    assert.equal(initial.status, 200);
    await api.db.doc("carts/user-a").update({ items: [{ id: "dish", quantity: 3 }] });
    const result = await api.commit([{ type: "update", path: "carts/user-a", data: { items: [] } }], "customer", [{ path: "carts/user-a", version: initial.body.version }]);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "DATABASE_CONFLICT");
    assert.equal((await api.db.doc("carts/user-a").get()).get("items")[0].quantity, 3);
  });
});

test("transaction preconditions cannot probe another owner's document version", async () => {
  await withHarness(async api => {
    const otherVersion = (await api.db.doc("orders/other").get()).version;
    for (const version of [otherVersion, otherVersion + 1]) {
      const result = await api.commit([{ type: "set", path: "carts/user-a", data: { items: [] } }], "customer", [{ path: "orders/other", version }]);
      assert.equal(result.status, 403);
      assert.equal(result.body.code, "DATABASE_FORBIDDEN");
      assert.equal((await api.db.doc("carts/user-a").get()).exists, false);
    }
  });
});

test("a batch cannot remove every active owner account", async () => {
  await withHarness(async api => {
    const result = await api.commit([
      { type: "delete", path: "admins/owner@example.com" },
      { type: "delete", path: "admins/backup@example.com" }
    ], "admin");
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "DATABASE_CONFLICT");
    assert.equal((await api.db.doc("admins/owner@example.com").get()).exists, true);
    assert.equal((await api.db.doc("admins/backup@example.com").get()).exists, true);
    assert.equal((await api.commit([{ type: "delete", path: "admins/backup@example.com" }], "admin")).status, 200);
    assert.equal((await api.commit([{ type: "update", path: "admins/owner@example.com", data: { active: false } }], "admin")).status, 409);
    assert.equal((await api.db.doc("admins/owner@example.com").get()).get("active"), true);
  });
});

test("configured primary access cannot be deleted, disabled, demoted, replaced, or unmarked through the API", async () => {
  const api = await harness("owner@example.com");
  try {
    const target = "admins/owner@example.com";
    const writes = [
      { type: "delete", path: target },
      { type: "update", path: target, data: { active: false } },
      { type: "update", path: target, data: { role: "limited" } },
      { type: "set", path: target, data: { email: "owner@example.com", role: "admin", active: true } },
      { type: "update", path: target, data: { primaryAdmin: false } },
      { type: "update", path: target, data: { managedBy: null } },
      { type: "delete", path: "roles/admin" },
      { type: "set", path: "roles/admin", data: { permissions: {} } }
    ];
    for (const write of writes) {
      const result = await api.commit([write], "admin");
      assert.equal(result.status, 409);
      assert.equal(result.body.code, "PRIMARY_ADMIN_MANAGED");
    }
    assert.equal((await api.db.doc(target).get()).get("active"), true);
    assert.equal((await api.db.doc(target).get()).get("managedBy"), "PRIMARY_ADMIN_EMAIL");
    assert.equal((await api.commit([{ type: "delete", path: "admins/backup@example.com" }], "admin")).status, 200);
  } finally { await api.close(); }
});

test("ordinary team grants cannot forge environment ownership markers", async () => {
  const api = await harness("owner@example.com");
  try {
    for (const metadata of [{ primaryAdmin: true }, { primaryAdmin: false }, { managedBy: "PRIMARY_ADMIN_EMAIL" }, { managedBy: null }]) {
      const result = await api.commit([{ type: "set", path: "admins/new@example.com", data: { email: "new@example.com", role: "admin", active: true, ...metadata } }], "admin");
      assert.equal(result.status, 400);
      assert.equal((await api.db.doc("admins/new@example.com").get()).exists, false);
    }
  } finally { await api.close(); }
});

test("matching configured primary email still requires verified authentication", async () => {
  const api = await harness("unverified@example.com");
  try {
    assert.equal((await api.query("roles", "unverified")).status, 403);
    assert.equal((await api.commit([{ type: "set", path: "settings/global", data: { restaurantName: "Forged" } }], "unverified")).status, 403);
    assert.equal((await api.query("admins", "customer")).status, 403);
  } finally { await api.close(); }
});

test("invalid database paths and malformed batches return stable errors", async () => {
  await withHarness(async api => {
    assert.equal((await api.query("orders/own", "customer", [], "collection")).status, 400);
    const result = await api.commit([{ type: "update", path: "carts//user-a", data: {} }], "customer");
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "DATABASE_INVALID_REQUEST");
  });
});

test("malformed query, write, and precondition shapes fail closed with stable client errors", async () => {
  await withHarness(async api => {
    for (const body of [null, [], { path: "menu", kind: "collection", filters: [null] }, { path: "menu", kind: "collection", orders: [null] },
      { path: "menu", kind: "collection", filters: [{ field: "constructor.prototype", op: "==", value: "x" }] },
      { path: "menu", kind: "collection", filters: [{ field: "name", op: "in", value: Array(101).fill("Dinner") }] },
      { path: "menu", kind: "collection", limit: 1001 }]) {
      const result = await api.request("/api/database/query", body);
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "DATABASE_INVALID_REQUEST");
    }
    for (const body of [null, [], { writes: [null] }, { writes: [{ type: "set", path: "carts/user-a", data: {} }], preconditions: [null] }]) {
      const result = await api.request("/api/database/commit", body, "customer");
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "DATABASE_INVALID_REQUEST");
    }
  });
});

test("deeply nested customer values are rejected before persistence", async () => {
  await withHarness(async api => {
    let nested: any = "value";
    for (let index = 0; index < 24; index++) nested = { child: nested };
    const result = await api.commit([{ type: "set", path: "carts/user-a", data: { nested } }], "customer");
    assert.equal(result.status, 400);
    assert.equal((await api.db.doc("carts/user-a").get()).exists, false);
  });
});

test("reviews cannot store objects or field transforms in display content", async () => {
  await withHarness(async api => {
    const valid = { menuItemId: "dish", rating: 5, customerName: "Customer A", comment: "Great dinner" };
    for (const patch of [{ comment: { html: "Stored object" } }, { customerName: { __op: "serverTimestamp" } }, { rating: 1.5 }, { text: ["text"] }, { comment: "a".repeat(5001) }]) {
      const result = await api.commit([{ type: "set", path: "reviews/rejected", data: { ...valid, ...patch } }], "customer");
      assert.equal(result.status, 400);
      assert.equal((await api.db.doc("reviews/rejected").get()).exists, false);
    }
    assert.equal((await api.commit([{ type: "set", path: "reviews/valid", data: valid }], "customer")).status, 200);
    assert.equal((await api.db.doc("reviews/valid").get()).get("userId"), "user-a");
  });
});

test("reservations validate display fields and cannot impersonate another email", async () => {
  await withHarness(async api => {
    const valid = { customerName: "Customer A", customerEmail: "a@example.com", customerPhone: "0912345678", date: "2026-10-20", time: "19:00", partySize: 2 };
    for (const patch of [{ customerName: {} }, { notes: { __op: "serverTimestamp" } }, { partySize: 100_000 }, { date: [] }]) {
      assert.equal((await api.commit([{ type: "set", path: "reservations/rejected", data: { ...valid, ...patch } }], "customer")).status, 400);
    }
    assert.equal((await api.commit([{ type: "set", path: "reservations/rejected", data: { ...valid, customerEmail: "victim@example.com" } }], "customer")).status, 403);
    assert.equal((await api.commit([{ type: "set", path: "reservations/valid", data: { ...valid, userId: "user-b", status: "confirmed" } }], "customer")).status, 200);
    const stored = (await api.db.doc("reservations/valid").get()).data()!;
    assert.equal(stored.userId, "user-a");
    assert.equal(stored.status, "pending");
  });
});

test("customer profile display fields reject objects and preserve authenticated identity", async () => {
  await withHarness(async api => {
    for (const patch of [{ displayName: {} }, { email: { __op: "deleteField" } }, { phone: [] }]) {
      assert.equal((await api.commit([{ type: "update", path: "users/user-a", data: patch }], "customer")).status, 400);
    }
    assert.equal((await api.commit([{ type: "update", path: "users/user-a", data: { uid: "user-b" } }], "customer")).status, 403);
    assert.equal((await api.commit([{ type: "update", path: "users/user-a", data: { email: "victim@example.com" } }], "customer")).status, 403);
    assert.equal((await api.db.doc("users/user-a").get()).get("email"), "a@example.com");
  });
});

test("role permissions and staff activity require primitive validated grant values", async () => {
  await withHarness(async api => {
    for (const data of [{ permissions: { "settings.edit": { __op: "increment", amount: 1 } } }, { permissions: null }, { permissions: [] }, { role: { __op: "deleteField" } }, { active: "false" }, { status: " disabled " }]) {
      const result = await api.commit([{ type: "update", path: "roles/limited", data }], "manager");
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "DATABASE_INVALID_REQUEST");
    }
    assert.equal((await api.db.doc("roles/limited").get()).data()?.permissions["menu.editPrice"], true);
  });
});

test("full promotion replacement preserves server-managed usage bookkeeping", async () => {
  await withHarness(async api => {
    await api.db.doc("promoCodes/SAVE").update({ reservedCount: 2, usedBy: ["user-a"], appliedOrders: ["own"] });
    assert.equal((await api.commit([{ type: "update", path: "promoCodes/SAVE", data: { reservedCount: 0 } }], "manager")).status, 403);
    assert.equal((await api.commit([{ type: "set", path: "promoCodes/NEW", data: { usageCount: 0, reservedCount: -99 } }], "manager")).status, 403);
    const result = await api.commit([{ type: "set", path: "promoCodes/SAVE", data: { code: "SAVE", active: true, value: 10 } }], "manager");
    assert.equal(result.status, 200);
    const stored = (await api.db.doc("promoCodes/SAVE").get()).data()!;
    assert.equal(stored.usageCount, 1);
    assert.equal(stored.reservedCount, 2);
    assert.deepEqual(stored.usedBy, ["user-a"]);
    assert.deepEqual(stored.appliedOrders, ["own"]);
  });
});

test("SSE announces revisions without broadcasting private records", async () => {
  await withHarness(async api => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${api.base}/api/database/events`, { signal: controller.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
      reader = response.body!.getReader();
      await api.db.doc("orders/other").update({ customerAddress: "VERY-PRIVATE-SSE-MARKER" });
      const revision = api.db.currentRevision();
      let text = "";
      let observed = false;
      while (!observed) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
        const frames = text.split(/\r?\n\r?\n/);
        text = frames.pop() || "";
        for (const frame of frames) {
          assert.equal(frame.includes("VERY-PRIVATE-SSE-MARKER"), false);
          assert.equal(frame.includes("PRIVATE-ADDRESS"), false);
          assert.equal(frame.includes("orders/"), false);
          const payload = frame.split(/\r?\n/).find(line => line.startsWith("data:"));
          if (!payload) continue;
          const data = JSON.parse(payload.slice(5).trim());
          assert.deepEqual(Object.keys(data), ["revision"]);
          assert.equal(typeof data.revision, "number");
          if (data.revision >= revision) observed = true;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  });
});
