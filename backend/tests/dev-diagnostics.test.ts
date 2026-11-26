import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { createLocalStore } from "../local-store";
import { ensureDevRole, resolveLocalStaffPermissions, syncPrimaryAdmin, DEV_ONLY_PERMISSION } from "../primary-admin";
import { installDatabaseApi } from "../database-api";
import { installDevDiagnosticRoutes, maskPhone, recordDevEvent } from "../dev-diagnostics";

test("ensureDevRole and permission resolver enforce read-only + exclusive dev access", async () => {
  const db = createLocalStore(":memory:");
  try {
    await syncPrimaryAdmin(db, "owner@example.com");
    await ensureDevRole(db);
    await db.doc("admins/dev@example.com").set({ email: "dev@example.com", role: "dev", active: true });
    await db.doc("roles/custom").set({ name: "Custom", permissions: { "menu.view": true, "dev.view": true } });
    await db.doc("admins/custom@example.com").set({ email: "custom@example.com", role: "custom", active: true });

    const devRoleDoc = (await db.doc("roles/dev").get()).data();
    assert.equal(devRoleDoc?.builtin, true);
    assert.equal(devRoleDoc?.permissions[DEV_ONLY_PERMISSION], true);
    assert.equal(devRoleDoc?.permissions["orders.view"], true);
    assert.equal(devRoleDoc?.permissions["settings.edit"], false);
    assert.equal(devRoleDoc?.permissions["data.clear"], false);

    // Even if DB record were tampered, resolver freezes dev to read-only + dev.view.
    await db.doc("roles/dev").update({ permissions: { "settings.edit": true, "dev.view": true } });
    const devCtx = await resolveLocalStaffPermissions(db, "dev@example.com", "owner@example.com");
    assert.equal(devCtx?.role, "dev");
    assert.equal(devCtx?.permissions[DEV_ONLY_PERMISSION], true);
    assert.equal(devCtx?.permissions["settings.edit"], false);
    assert.equal(devCtx?.permissions["orders.updateStatus"], false);
    assert.equal(devCtx?.permissions["menu.edit"], false);

    // Admin does not gain dev.view; custom roles cannot claim dev.view.
    const ownerCtx = await resolveLocalStaffPermissions(db, "owner@example.com", "owner@example.com");
    assert.equal(ownerCtx?.role, "admin");
    assert.equal(ownerCtx?.permissions[DEV_ONLY_PERMISSION], undefined);

    const customCtx = await resolveLocalStaffPermissions(db, "custom@example.com", "owner@example.com");
    assert.equal(customCtx?.permissions["menu.view"], true);
    assert.equal(customCtx?.permissions[DEV_ONLY_PERMISSION], undefined);
  } finally {
    db.close();
  }
});

test("database API gives dev strict read-only access, protects roles/dev, and hides dev_events", async () => {
  const db = createLocalStore(":memory:");
  let server!: Server;
  try {
    await syncPrimaryAdmin(db, "owner@example.com");
    await ensureDevRole(db);
    await db.doc("admins/dev@example.com").set({ email: "dev@example.com", role: "dev", active: true });
    await db.doc("menu/dish").set({ name: "Shiro", price: 120, isActive: true });
    await db.doc("orders/ord1").set({ userId: "cust1", total: 120, status: "pending" });
    await db.doc("users/cust1").set({ uid: "cust1", email: "c@example.com", displayName: "Cust" });
    await db.doc("settings/global").set({ restaurantName: "Savory" });
    await db.doc("audit_log/a1").set({ actorEmail: "owner@example.com", action: "test", category: "general", createdAt: new Date().toISOString() });
    await recordDevEvent(db, { category: "sms", status: "success", source: "shipday", summary: "SMS ok" });

    const actors: Record<string, any> = {
      admin: { uid: "u-admin", email: "owner@example.com", email_verified: true },
      dev: { uid: "u-dev", email: "dev@example.com", email_verified: true }
    };
    const app = express();
    app.use(express.json({ strict: false }));
    installDatabaseApi(app, db, {
      verifyToken: async req => actors[String(req.headers.authorization || "").replace(/^Bearer /, "")] || null,
      resolveStaffPermissions: email => resolveLocalStaffPermissions(db, email, "owner@example.com"),
      primaryAdminEmail: "owner@example.com"
    });
    server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server.address() as any).port;
    const call = async (route: string, body: unknown, token: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      return { status: r.status, body: await r.json() as any };
    };

    for (const col of ["menu", "orders", "users", "admins", "roles", "audit_log"]) {
      const res = await call("/api/database/query", { path: col, kind: "collection", filters: [], orders: [] }, "dev");
      assert.equal(res.status, 200, `dev should read ${col}`);
    }
    const readSettings = await call("/api/database/query", { path: "settings/global", kind: "document" }, "dev");
    assert.equal(readSettings.status, 200);

    // dev cannot mutate any collection
    for (const path of ["menu/dish", "settings/global", "categories/cat1", "promoCodes/NEW", "roles/dev"]) {
      const res = await call("/api/database/commit", { writes: [{ type: "set", path, data: { hacked: true }, merge: true }] }, "dev");
      assert.equal(res.status, 403, `dev write to ${path} must be denied`);
    }

    // admin cannot edit or delete builtin roles/dev or grant dev.view on another role
    const editDev = await call("/api/database/commit", { writes: [{ type: "set", path: "roles/dev", data: { name: "Edited" }, merge: true }] }, "admin");
    assert.equal(editDev.status, 409);
    const delDev = await call("/api/database/commit", { writes: [{ type: "delete", path: "roles/dev" }] }, "admin");
    assert.equal(delDev.status, 409);
    const grantDevPerm = await call("/api/database/commit", { writes: [{ type: "set", path: "roles/custom", data: { id: "custom", name: "Custom", permissions: { "dev.view": true } } }] }, "admin");
    assert.equal(grantDevPerm.status, 403);

    // admin CAN assign a user to role "dev"
    const assignDev = await call("/api/database/commit", { writes: [{ type: "set", path: "admins/newdev@example.com", data: { email: "newdev@example.com", role: "dev", active: true } }] }, "admin");
    assert.equal(assignDev.status, 200);

    // dev_events is never readable via generic DB API
    for (const token of ["admin", "dev"]) {
      const hidden = await call("/api/database/query", { path: "dev_events", kind: "collection", filters: [], orders: [] }, token);
      assert.equal(hidden.status, 403);
    }
  } finally {
    server?.close();
    db.close();
  }
});

test("dev diagnostic routes require dev role, redact secrets, filter SMS logs, and detect stuck orders", async () => {
  const db = createLocalStore(":memory:");
  let server!: Server;
  try {
    await syncPrimaryAdmin(db, "owner@example.com");
    await ensureDevRole(db);
    await db.doc("admins/dev@example.com").set({ email: "dev@example.com", role: "dev", active: true });
    await db.doc("audit_log/a1").set({ actorEmail: "owner@example.com", action: "keep-me", category: "general", createdAt: new Date().toISOString() });
    await db.doc("orders/STUCK1").set({
      id: "STUCK1",
      status: "cancel_requested",
      paymentMethod: "chapa",
      paymentStatus: "pending",
      paymentAttemptStatus: "reconciling",
      shipdayDispatchState: "failed",
      shipdayDispatchError: "Timeout",
      total: 250,
      createdAt: new Date().toISOString()
    });
    await recordDevEvent(db, {
      category: "sms",
      status: "success",
      source: "shipday-delivery-sms",
      summary: "SMS queued",
      orderId: "STUCK1",
      recipient: maskPhone("+251911223344"),
      details: { secretKey: "MUST_BE_REDACTED", orderRef: "STUCK1" }
    });
    await recordDevEvent(db, { category: "error", status: "failed", source: "http:POST /api/orders", summary: "HTTP 500", httpStatus: 500 });

    const actors: Record<string, any> = {
      admin: { uid: "u-admin", email: "owner@example.com", email_verified: true },
      dev: { uid: "u-dev", email: "dev@example.com", email_verified: true }
    };
    const app = express();
    app.use(express.json());
    const requireStaffAuth = async (req: any, res: any, next: any) => {
      const actor = actors[String(req.headers.authorization || "").replace(/^Bearer /, "")];
      if (!actor) return res.status(401).json({ error: "Unauthorized" });
      const staff = await resolveLocalStaffPermissions(db, actor.email, "owner@example.com");
      if (!staff) return res.status(403).json({ error: "Forbidden" });
      res.locals.staff = staff;
      next();
    };
    const requireDevRole = (_req: any, res: any, next: any) => {
      if (res.locals.staff?.role !== "dev" || res.locals.staff?.permissions?.["dev.view"] !== true) {
        return res.status(403).json({ error: "Forbidden" });
      }
      next();
    };

    const mockEnv: Record<string, string> = {
      APP_URL: "https://freshmen.me",
      PRIMARY_ADMIN_EMAIL: "owner@example.com",
      CHAPA_SECRET_KEY: "CHASECK_TEST-secret-value",
      CHAPA_WEBHOOK_SECRET: "whsec_fixture",
      MAILCHIMP_API_KEY: "mc-us1",
      MAILCHIMP_LIST_ID: "list123"
    };
    installDevDiagnosticRoutes(app, db, {
      requireStaffAuth,
      requireDevRole,
      getCleanEnv: (k, f = "") => mockEnv[k] ?? f,
      isMissingOrPlaceholderSecret: v => !v,
      appUrl: "https://freshmen.me",
      databasePath: ":memory:",
      firebaseConfig: { projectId: "proj-1", authDomain: "proj-1.firebaseapp.com" },
      shipdayService: { testConnection: async () => ({ success: true, message: "OK", orderCount: 0 }) },
      startedAt: Date.now() - 5000,
      fetcher: (async (url: string) => {
        if (url.includes("mailchimp.com")) return new Response(JSON.stringify({ name: "SAVORY", stats: { member_count: 3 } }), { status: 200 });
        if (url.includes("chapa.co")) return new Response("{}", { status: 200 });
        return new Response("", { status: 200 });
      }) as typeof fetch
    });

    server = await new Promise<Server>(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server.address() as any).port;
    const req = async (route: string, method = "GET", token?: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {}
      });
      return { status: r.status, body: await r.json() as any };
    };

    // Auth & exclusivity checks
    assert.equal((await req("/api/dev/diagnostics")).status, 401);
    assert.equal((await req("/api/dev/diagnostics", "GET", "admin")).status, 403);
    assert.equal((await req("/api/dev/events", "GET", "admin")).status, 403);
    assert.equal((await req("/api/dev/integrations/check", "POST", "admin")).status, 403);
    assert.equal((await req("/api/dev/events/clear", "POST", "admin")).status, 403);

    // Diagnostics payload check
    const diag = await req("/api/dev/diagnostics", "GET", "dev");
    assert.equal(diag.status, 200);
    assert.equal(diag.body.stuckOrders.length, 1);
    assert.equal(diag.body.stuckOrders[0].id, "STUCK1");
    assert.equal(diag.body.eventSummary.smsSuccess, 1);
    assert.equal(diag.body.eventSummary.errors, 1);
    const diagText = JSON.stringify(diag.body);
    assert.equal(diagText.includes("CHASECK_TEST-secret-value"), false);

    // Filtered SMS events check + redaction
    const smsRes = await req("/api/dev/events?category=sms&status=success", "GET", "dev");
    assert.equal(smsRes.status, 200);
    assert.equal(smsRes.body.events.length, 1);
    assert.equal(smsRes.body.events[0].recipient, "+251***3344");
    assert.equal(smsRes.body.events[0].details.secretKey, undefined);
    assert.equal(smsRes.body.events[0].details.orderRef, "STUCK1");

    // Health suite check
    const suiteRes = await req("/api/dev/integrations/check", "POST", "dev");
    assert.equal(suiteRes.status, 200);
    assert.equal(suiteRes.body.results.shipday.ok, true);
    assert.equal(suiteRes.body.results.mailchimp.ok, true);
    assert.equal(suiteRes.body.results.chapa.mode, "test");
    assert.equal(suiteRes.body.results.firebaseAuth.ok, true);
    assert.equal(suiteRes.body.results.sqlite.ok, true);

    // Clear dev events preserves audit_log
    const clearRes = await req("/api/dev/events/clear", "POST", "dev");
    assert.equal(clearRes.status, 200);
    assert.ok(clearRes.body.cleared >= 2);
    assert.equal((await db.collection("audit_log").get()).size, 1);
  } finally {
    server?.close();
    db.close();
  }
});
