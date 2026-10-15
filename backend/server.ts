/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import axios from "axios";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { createLocalStore } from "./local-store";
import { initializeLocalData } from "./local-data";
import { parsePrimaryAdminEmail, syncPrimaryAdmin, resolveLocalStaffPermissions, isPrimaryAdminProtectedPath } from "./primary-admin";
import { installDatabaseApi, assertMenuWritePermissions } from "./database-api";
import fs from "fs";
import { mapChapaFailure, normalizeChapaMessage, safeChapaDiagnostic } from "./chapa-errors";
import { createChapaCustomization } from "./chapa-payload";
import { chapaPhoneNumber } from "./chapa-phone";
import { checkoutValidationError, safeCheckoutFailure } from "./checkout-validation";
import { installHttpSecurity, publicOrigin, requestOrigin, validateJsonShape, safeApiError, authenticatedOrderLimit } from "./http-security";
import { redactServerSecrets, validatedCheckoutSettings, safeAuthRedirect, mergeFirebaseConfiguration } from "./config-security";
import { buildStaffOrderUpdate } from "./order-security";
import { acceptCashOrderPromotion, reserveOrderPromotion, completeOrderPromotion, releaseOrderPromotion, promotionCapacity, promotionDiscount } from "./promotion-security";
import { isChapaCheckoutUrl, assertChapaWebhookSignature, createChapaVerificationClient, chapaPaymentMatchDiagnostics as securePaymentDiagnostics, assertVerifiedChapaSettlement, isFinalPaymentStatus, isChapaAdjustmentStatus, buildChapaAdjustmentReconciliation, assertNewChapaAttemptCapacity, hasConfirmedChapaFailure, readChapaJsonResponse, validPaymentReference, cancelChapaTransaction } from "./chapa-security";
import { createShipdayService, installShipdayRoutes } from "./shipday-security";

const appRoot = process.env.APP_ROOT || (fs.existsSync(path.join(process.cwd(), "frontend")) ? process.cwd() : path.resolve(process.cwd(), ".."));
dotenv.config({ path: path.join(appRoot, ".env") });
// Coolify environment variables take precedence over a local .env file.
// Freeze primary access until a full backend restart so rotation is atomic.
const PRIMARY_ADMIN_EMAIL = parsePrimaryAdminEmail(process.env.PRIMARY_ADMIN_EMAIL);

/** Configuration is read once; runtime environment takes precedence over .env. */
export function getCleanEnv(key: string, fallback = ""): string {
  return String(process.env[key] ?? fallback).trim().replace(/^["']|["']$/g, "").trim();
}
const PRODUCTION = process.env.NODE_ENV === "production";
const APP_PUBLIC_ORIGIN = publicOrigin(getCleanEnv("APP_URL"), PRODUCTION);
export function resolveBaseUrl(_req?: any): string { return APP_PUBLIC_ORIGIN; }

let firebaseConfig: any = {
  apiKey: getCleanEnv("VITE_FIREBASE_API_KEY"),
  authDomain: getCleanEnv("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: getCleanEnv("VITE_FIREBASE_PROJECT_ID") || getCleanEnv("FIREBASE_PROJECT_ID"),
  storageBucket: getCleanEnv("VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: getCleanEnv("VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: getCleanEnv("VITE_FIREBASE_APP_ID"),
  measurementId: getCleanEnv("VITE_FIREBASE_MEASUREMENT_ID")
};

try {
  const configPath = path.join(appRoot, "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    const configRaw = fs.readFileSync(configPath, "utf-8");
    firebaseConfig = mergeFirebaseConfiguration(JSON.parse(configRaw), firebaseConfig);
  }
} catch (e) {
  console.warn("Could not load firebase-applet-config.json", e);
}

// Google sign-in tokens are verified against this explicit Firebase project.
// Business data lives in SQLite; no Google application credentials are needed.
if (!firebaseConfig.projectId) throw new Error("Configure VITE_FIREBASE_PROJECT_ID for Google sign-in.");
const appFirebase = initializeApp({ projectId: firebaseConfig.projectId });
const databasePath = path.resolve(appRoot, getCleanEnv("DATABASE_PATH", "data/savory.sqlite"));
const db = createLocalStore(databasePath);

const app = express();
installHttpSecurity(app, { origin: APP_PUBLIC_ORIGIN, production: PRODUCTION, proxyCidrs: getCleanEnv("TRUST_PROXY_CIDRS") });
app.param(["id", "txRef"], (_req, res, next, value) => {
  if (typeof value !== "string" || value.length > 200 || [".", ".."].includes(value) || /[\u0000-\u001f/\\]/.test(value)) return res.status(400).json({ error: "Invalid resource identifier." });
  next();
});
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const CHECKOUT_FLOW_VERSION = "local-sqlite-v9";
const CHECKOUT_REQUEST_DEADLINE_MS = 30000;
const CHECKOUT_ATTEMPT_LEASE_MS = 35000;
const customerOrderLimit = authenticatedOrderLimit();

// Start the checkout budget before authentication middleware so the 30-second
// server deadline covers Firebase auth, SQLite, and Chapa.
app.use((req: any, _res: any, next: any) => {
  req.requestStartedAt = Date.now();
  next();
});

function withinDeadline<T>(operation: Promise<T>, deadlineAt: number, stage: string): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return Promise.reject(Object.assign(new Error("Checkout request deadline reached."), { name: "TimeoutError", stage }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Checkout request deadline reached."), { name: "TimeoutError", stage })), remainingMs);
  });
  return Promise.race([operation, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

// Keep Firebase redirect authentication on the application's own origin.
// Modern browsers can block the cross-origin storage Firebase needs when the
// helper remains on *.firebaseapp.com, causing a successful Google sign-in to
// return as a signed-out user. The client uses window.location.host as its
// authDomain and this route transparently serves the official helper assets.
app.use("/__/auth", async (req, res) => {
  const upstreamAuthDomain = String(firebaseConfig.authDomain || "").trim();
  if (!/^[a-z0-9][a-z0-9-]*\.(?:firebaseapp\.com|web\.app)$/i.test(upstreamAuthDomain)) {
    return res.status(503).send("Firebase authentication is not configured.");
  }

  const upstreamUrl = `https://${upstreamAuthDomain}${req.originalUrl}`;
  const forwardedHeaders: Record<string, string> = {};
  if (!["GET", "HEAD", "POST"].includes(req.method)) return res.sendStatus(405);
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || !["accept", "accept-language", "content-type", "user-agent"].includes(name.toLowerCase())) continue;
    forwardedHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  forwardedHeaders.host = upstreamAuthDomain;

  try {
    const upstream = await axios.request<ArrayBuffer>({
      method: req.method,
      url: upstreamUrl,
      headers: forwardedHeaders,
      data: ["GET", "HEAD"].includes(req.method) ? undefined : req,
      responseType: "arraybuffer",
      adapter: "http", timeout: 15000, maxContentLength: 2 * 1024 * 1024, maxBodyLength: 256 * 1024,
      maxRedirects: 0,
      validateStatus: () => true
    });

    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value === undefined || ["connection", "content-length", "content-encoding", "transfer-encoding", "set-cookie"].includes(name.toLowerCase())) continue;
      res.setHeader(name, Array.isArray(value) ? value : String(value));
    }

    const location = upstream.headers.location;
    if (location) {
      const target = safeAuthRedirect(String(location), `https://${upstreamAuthDomain}`, requestOrigin(req, APP_PUBLIC_ORIGIN, PRODUCTION));
      if (!target) return res.status(502).send("Authentication returned an invalid redirect.");
      res.setHeader("location", target);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(upstream.status).send(Buffer.from(upstream.data));
  } catch (error: any) {
    console.error("[FIREBASE AUTH PROXY] Upstream request failed.");
    return res.status(502).send("Firebase authentication service is temporarily unavailable.");
  }
});

// Checkout is intentionally a compact, ID-only request. Keep its JSON body
// small so base64 menu images or an interrupted tunnel upload cannot consume
// the browser's entire checkout deadline. Other routes retain the larger limit
// for existing image and webhook payloads.
const captureJsonBody = (req: any, _res: any, buf: Buffer) => {
  if (["/api/chapa/webhook", "/api/shipday/webhook"].includes(req.path)) req.rawBody = Buffer.from(buf);
  if (req.path === "/api/chapa/initialize") {
    req.checkoutBodyBytes = buf.length;
    req.checkoutBodyParsedAt = Date.now();
  }
};
const checkoutJsonParser = express.json({ limit: "256kb", inflate: false, verify: captureJsonBody });
const generalJsonParser = express.json({ limit: "1mb", inflate: false, verify: captureJsonBody });
const staffJsonParser = express.json({ limit: "32mb", inflate: false, verify: captureJsonBody });
app.use(async (req: any, res: any, next: any) => {
  try {
    if (req.method === "POST" && req.path === "/api/chapa/initialize") {
      req.checkoutBodyStartedAt = Date.now();
      return checkoutJsonParser(req, res, next);
    }
    const largeRoute = req.method === "POST" && ["/api/database/commit", "/api/menu"].includes(req.path);
    if (largeRoute && (req.get("authorization") || req.get("x-firebase-token"))) {
      const actor = await verifyFirebaseToken(req);
      const staff = actor?.email_verified === true ? await resolveStaffPermissions(String(actor.email || "")) : null;
      if (staff && ["menu.create", "menu.edit", "settings.edit"].some(permission => staffHas(staff, permission))) return staffJsonParser(req, res, next);
    }
    return generalJsonParser(req, res, next);
  } catch (error) { next(error); }
});
app.use(validateJsonShape);
app.use((error: any, req: any, res: any, next: any) => {
  if (req.path !== "/api/chapa/initialize") return next(error);
  const bodyStartedAt = Number(req.checkoutBodyStartedAt) || Number(req.requestStartedAt) || Date.now();
  if (error?.type === "request.aborted" || req.aborted) {
    console.warn(JSON.stringify({ event: "checkout_body_aborted", bodyMs: Date.now() - bodyStartedAt, receivedBytes: Number(error?.received || 0), expectedBytes: Number(error?.expected || req.headers?.["content-length"] || 0) || null }));
    if (res.destroyed || req.destroyed) return;
    return res.status(400).json({ success: false, code: "CHECKOUT_BODY_INCOMPLETE", error: "Checkout details were interrupted. Please retry.", retryAction: "same_reference" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ success: false, code: "CHECKOUT_PAYLOAD_TOO_LARGE", error: "Checkout details are too large. Refresh your cart and try again.", retryAction: "same_reference" });
  }
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, code: "INVALID_CHECKOUT_BODY", error: "Checkout details could not be read. Please retry.", retryAction: "same_reference" });
  }
  return next(error);
});

// Middleware: require a valid Firebase ID token for admin/staff-only routes.
// Token is read from the `Authorization: Bearer <idToken>` header, with a
// fallback to `x-firebase-token` header for non-browser callers.
async function verifyFirebaseToken(req: any): Promise<any | null> {
  if (req.firebaseVerification) return req.firebaseVerification;
  req.firebaseVerification = (async () => {
    try {
      const header = String(req.headers?.authorization || "");
      const token = /^Bearer ([^\s]+)$/i.exec(header)?.[1] || String(req.headers?.["x-firebase-token"] || "");
      if (!token || token.length > 16384 || /\s/.test(token)) return null;
      return await withinDeadline(getAuth(appFirebase).verifyIdToken(token), Date.now() + 8000, "auth");
    } catch { return null; }
  })();
  return req.firebaseVerification;
}

async function requireStaffAuth(req: any, res: any, next: any) {
  const decodedToken = await verifyFirebaseToken(req);
  if (!decodedToken) {
    return res.status(401).json({ error: "Unauthorized: Invalid or expired Firebase ID token." });
  }
  const staff = decodedToken.email_verified === true
    ? await resolveStaffPermissions(String(decodedToken.email || "")) : null;
  if (!staff || staff.disabled === true) {
    return res.status(403).json({ error: "Forbidden: an active staff account is required." });
  }
  res.locals.uid = decodedToken.uid;
  res.locals.token = decodedToken;
  res.locals.staff = staff;
  next();
}

// Middleware: require a valid signed-in customer session. Strictly enforces
// that every order is placed by an authenticated account (no guest checkout).
async function requireCustomerAuth(req: any, res: any, next: any) {
  const authStartedAt = Date.now();
  let decodedToken: any;
  try {
    decodedToken = await withinDeadline(
      verifyFirebaseToken(req),
      (Number(req.requestStartedAt) || authStartedAt) + CHECKOUT_REQUEST_DEADLINE_MS,
      "auth"
    );
  } catch (error: any) {
    if (error?.name !== "TimeoutError") throw error;
    const requestStartedAt = Number(req.requestStartedAt) || authStartedAt;
    const bodyStartedAt = Number(req.checkoutBodyStartedAt) || requestStartedAt;
    const bodyFinishedAt = Number(req.checkoutBodyParsedAt) || authStartedAt;
    const bodyMs = Math.max(0, bodyFinishedAt - bodyStartedAt);
    const authMs = Date.now() - authStartedAt;
    console.warn(JSON.stringify({ event: "checkout_deadline_timeout", stage: bodyMs >= authMs && bodyMs > 1000 ? "body_upload_or_parse" : "auth", bodyMs, authMs, totalMs: Date.now() - requestStartedAt }));
    return res.status(503).json({ success: false, code: "AUTH_CHECK_TIMEOUT", error: "Sign-in verification is taking longer than expected. Please retry checkout.", retryAction: "same_reference" });
  }
  if (!decodedToken) {
    if (req.path === "/api/chapa/initialize") {
      return res.status(401).json({ success: false, code: "AUTH_SESSION_EXPIRED", error: "Please sign in again to start checkout.", retryAction: "wait" });
    }
    return res.status(401).json({ error: "Please sign in to place an order." });
  }
  res.locals.uid = decodedToken.uid;
  res.locals.token = decodedToken;
  res.locals.authMs = Date.now() - authStartedAt;
  next();
}

// Primary access comes from server configuration; team roles come from SQLite.
async function resolveStaffPermissions(email: string, transaction?: any): Promise<{ role: string; permissions: Record<string, boolean>; disabled?: boolean } | null> {
  try {
    return await resolveLocalStaffPermissions(db, email, PRIMARY_ADMIN_EMAIL, transaction);
  } catch (err: any) {
    console.warn("[AUTH] Failed to resolve staff permissions:", err?.message);
    return null;
  }
}

// True when the caller's role holds the given permission (admin always passes).
function staffHas(permCtx: { role: string; permissions: Record<string, boolean> } | null, perm: string): boolean {
  if (!permCtx) return false;
  if (permCtx.role === "admin") return true;
  return permCtx.permissions[perm] === true;
}

// True when an env secret is unset or still a known dev placeholder. Webhook /
// callback routes use this to FAIL CLOSED instead of silently skipping verification.
function isMissingOrPlaceholderSecret(value?: string): boolean {
  const secret = String(value || "").trim().replace(/^["']|["']$/g, "").trim();
  if (!secret) return true;
  const placeholders = [
    "MY_CHAPA_WEBHOOK_SECRET",
    "YOUR_CHAPA_WEBHOOK_SECRET",
    "MY_SHIPDAY_WEBHOOK_TOKEN",
    "YOUR_SHIPDAY_WEBHOOK_TOKEN",
    "CHAPASECKEY-XXXX",
    "SHIPDAY_WEBHOOK_TOKEN_XXXX"
  ];
  const upper = secret.toUpperCase();
  return placeholders.some((p) => upper.includes(p)) ||
    /(?:your[_-]?|replace[_-]?me|change[_-]?me|placeholder|example)/i.test(secret) ||
    /^x+$/i.test(secret);
}

// Order cancellations are handled explicitly via Chapa webhooks, callbacks,
// and customer verification APIs to prevent cancelling orders that customers are actively paying for.
async function sweepStaleOrdersLazy() {
  // Retained as a no-op placeholder for any lingering call-sites
}


// All delivery creation paths share the same persisted concurrency claim.
const shipdayService = createShipdayService(db, {
  getApiKey: () => getCleanEnv("SHIPDAY_API_KEY"),
  getWebhookToken: () => getCleanEnv("SHIPDAY_WEBHOOK_TOKEN")
});
async function triggerShipday(orderId: string, _db: any, deliveryMinutes?: number) {
  return shipdayService.create(orderId, deliveryMinutes || undefined);
}


async function getCheckoutSettings(db: any) {
  const now = Date.now();
  if (checkoutSettingsCache && checkoutSettingsCache.expiresAt > now) return checkoutSettingsCache.value;
  try {
    const snap = await db.collection("settings").doc("checkout").get();
    const value = snap.exists ? snap.data() : {};
    checkoutSettingsCache = { value, expiresAt: now + 15000 };
    return value;
  } catch (e) {
    throw checkoutValidationError("CHECKOUT_SETTINGS_UNAVAILABLE", 503);
  }
}
let checkoutSettingsCache: { value: any; expiresAt: number } | null = null;

// ---- Operating schedule ----
// Orders are accepted between openTime and (closeTime - prepTimeMinutes) so
// the kitchen can finish preparing existing orders before closing.
function parseHHMM(value: any): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!m) return null;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return mins >= 0 && mins < 1440 ? mins : null;
}

function scheduleAcceptsOrders(cfg: any, now: Date = new Date()): { accepting: boolean; reason?: "notOpen" | "stopOrders" } {
  // Schedule computes availability only; the caller applies the manual isOpen toggle when no schedule is set.
  if (!cfg || !cfg.scheduleEnabled) return { accepting: true };
  const open = parseHHMM(cfg.openTime);
  const close = parseHHMM(cfg.closeTime);
  if (open === null || close === null) return { accepting: true };
  const prep = Math.max(0, parseInt(cfg.prepTimeMinutes, 10) || 30);
  const cutoff = Math.min(1440, close - prep);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (open < close) {
    if (nowMin >= open && nowMin < cutoff) return { accepting: true };
    return { accepting: false, reason: nowMin < open ? "notOpen" : "stopOrders" };
  }
  // Overnight schedule (e.g. 18:00 → 02:00).
  if (nowMin >= open || nowMin < cutoff) return { accepting: true };
  return { accepting: false, reason: nowMin >= cutoff ? "stopOrders" : "notOpen" };
}

function normalizeScheduledFor(scheduledFor: any, prepTimeMinutes: number): string | null {
  if (!scheduledFor) return null;
  const date = new Date(scheduledFor as string);
  if (isNaN(date.getTime())) return null;
  const now = new Date();
  const min = new Date(now.getTime() + prepTimeMinutes * 60 * 1000);
  if (date.getTime() < min.getTime()) return null;
  return date.toISOString();
}


// 0. Category Endpoints
app.get("/api/categories", async (req, res) => {
  try {
    const snapshot = await db.collection("categories").get();
    const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

app.post("/api/categories", requireStaffAuth, requireStaffPermission("menu.categories"), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Category name is required." });
    }

    const id = name.toLowerCase().replace(/\s+/g, '-');
    await db.collection("categories").doc(id).set({ name });

    const snapshot = await db.collection("categories").get();
    const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, categories });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to create category" });
  }
});

app.delete("/api/categories/:id", requireStaffAuth, requireStaffPermission("menu.categories"), async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("categories").doc(id).delete();

    const snapshot = await db.collection("categories").get();
    const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, categories });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete category" });
  }
});

// 1. Menu Endpoints
app.get("/api/menu", async (req, res) => {
  try {
    const snapshot = await db.collection("menu").get();
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(menu);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch menu items" });
  }
});

app.post("/api/menu", requireStaffAuth, async (req, res) => {
  try {
    const item = req.body;
    if (!item.name || !item.price || !item.category) {
      return res.status(400).json({ error: "Name, price, and category are required." });
    }

    const itemId = item.id || Math.random().toString(36).substring(2, 11);
    const newItem = {
      ...item,
      id: itemId,
      ingredients: item.ingredients || [],
      nutrition: item.nutrition || { protein: "0g", carbs: "0g", fat: "0g" },
      basePrice: item.basePrice !== undefined ? item.basePrice : item.price,
      isActive: item.isActive !== false,
      menuTiming: item.menuTiming || "All Day",
      categories: item.categories || [item.category],
      promoStickers: item.promoStickers || [],
      galleryImages: item.galleryImages || []
    };

    const itemRef = db.collection("menu").doc(itemId);
    await db.runTransaction(async transaction => {
      const existing = await transaction.get(itemRef);
      const staff = await resolveStaffPermissions(String(res.locals.token.email || ""), transaction);
      assertMenuWritePermissions(staff, existing.data(), newItem, "set");
      if (existing.exists) transaction.set(itemRef, newItem);
      else transaction.create(itemRef, newItem);
    });

    const snapshot = await db.collection("menu").get();
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, menu });
  } catch (error: any) {
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to save menu item" });
  }
});

app.delete("/api/menu/:id", requireStaffAuth, requireStaffPermission("menu.delete"), async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("menu").doc(id).delete();

    const snapshot = await db.collection("menu").get();
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, menu });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete menu item" });
  }
});

// 2. Order Endpoints
app.get("/api/orders", requireStaffAuth, requireStaffAnyPermission(["orders.view", "kds.view"]), async (req, res) => {
  try {
    const snapshot = await db.collection("orders").orderBy("createdAt", "desc").get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

app.post("/api/orders", requireCustomerAuth, customerOrderLimit, async (req, res) => {
  try {
    const orderData = req.body;
    if (!orderData.items || orderData.items.length === 0) {
      return res.status(400).json({ error: "Order items cannot be empty." });
    }
    if (orderData.userId && orderData.userId !== res.locals.uid) {
      return res.status(403).json({ error: "Order account does not match your session." });
    }

    if (orderData.paymentMethod && orderData.paymentMethod !== "cash") return res.status(400).json({ error: "Use the online checkout endpoint for Chapa payments." });
    const clientRequestId = String(orderData.clientRequestId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    if (clientRequestId.length < 24) return res.status(400).json({ error: "Refresh checkout and try again." });
    const orderId = "ORD-" + crypto.randomUUID().replace(/-/g, "");
    const nowISO = new Date().toISOString();
    const status = "pending";
    const fulfillmentType = ['delivery', 'pickup', 'dineIn'].includes(orderData.fulfillmentType) ? orderData.fulfillmentType : 'delivery';
    const checkoutCfg = await getCheckoutSettings(db);
    const prepTimeMinutes = checkoutCfg.prepTimeMinutes || 30;
    const scheduledFor = normalizeScheduledFor(orderData.scheduledFor, prepTimeMinutes);

    // Stop accepting orders `prepTimeMinutes` before closing time.
    // Manual toggle (isOpen) still gates when no schedule is configured.
    const schedule = scheduleAcceptsOrders(checkoutCfg);
    const accepting = checkoutCfg.scheduleEnabled ? schedule.accepting : checkoutCfg.isOpen !== false;
    if (!accepting) {
      return res.status(400).json({ error: "We're currently not accepting orders." });
    }

    if (checkoutCfg.enableCOD === false) return res.status(409).json({ error: "Cash payment is not available. Choose online payment." });
    const pricing = await calculateChapaOrder(orderData);
    const { items: recomputedItems, total, serviceTax, flatFee, discountAmount } = pricing;
    // P0: paymentStatus is FORCED to 'pending' on creation regardless of client input;
    // it can only become 'completed' after the Chapa webhook/verification flow.
    const paymentStatus = "pending";

    const newOrder = {
      id: orderId,
      items: recomputedItems,
      status: status,
      total: total,
      customerName: orderData.customerName,
      customerEmail: orderData.customerEmail,
      customerPhone: orderData.customerPhone,
      blockNumber: orderData.blockNumber || "",
      roomNumber: orderData.roomNumber || "",
      googleMapsAddress: orderData.googleMapsAddress || "",
      specialInstructions: orderData.specialInstructions || "",
      paymentMethod: orderData.paymentMethod || "cash",
      paymentStatus: paymentStatus,
      fulfillmentType,
      scheduledFor,
      transactionRef: orderId,
      createdAt: nowISO,
      updatedAt: nowISO,
      statusHistory: [{ status, at: nowISO }],
      paymentHistory: [{ paymentStatus, at: nowISO }],
      userId: res.locals.uid,
      serviceTax: serviceTax,
      flatFee: flatFee,
      promoCode: orderData.promoCode ? String(orderData.promoCode).trim().toUpperCase() : null,
      discountAmount: discountAmount
    };

    const orderRef = db.collection("orders").doc(orderId);
    const requestRef = db.collection("orderRequests").doc(crypto.createHash("sha256").update(res.locals.uid + ":" + clientRequestId).digest("hex"));
    const cashRequestHash = crypto.createHash("sha256").update(JSON.stringify({ items: recomputedItems, customerName: orderData.customerName, customerEmail: orderData.customerEmail, customerPhone: orderData.customerPhone, fulfillmentType, scheduledFor, promoCode: newOrder.promoCode, blockNumber: newOrder.blockNumber, roomNumber: newOrder.roomNumber, googleMapsAddress: newOrder.googleMapsAddress, specialInstructions: newOrder.specialInstructions })).digest("hex");
    let finalOrder: any = newOrder;
    await db.runTransaction(async (transaction: any) => {
      const requestSnap = await transaction.get(requestRef);
      if (requestSnap.exists) {
        if (requestSnap.data()?.requestHash && requestSnap.data()?.requestHash !== cashRequestHash) throw Object.assign(new Error("Checkout details changed. Start a new order."), { statusCode: 409, code: "ORDER_REQUEST_CHANGED" });
        const existingId = String(requestSnap.data()?.orderId || "");
        if (!existingId) throw new Error("Order request is invalid.");
        const existingRef = db.collection("orders").doc(existingId);
        const existingOrder = await transaction.get(existingRef);
        if (!existingOrder.exists || existingOrder.data()?.userId !== res.locals.uid) throw new Error("Existing order request could not be recovered.");
        finalOrder = { id: existingOrder.id, ...existingOrder.data() };
        return;
      }
      const promoFields = await acceptCashOrderPromotion(transaction, db, newOrder);
      transaction.create(orderRef, { ...newOrder, ...promoFields });
      transaction.create(requestRef, { orderId, userId: res.locals.uid, requestHash: cashRequestHash, createdAt: nowISO });
      finalOrder = { ...newOrder, ...promoFields };
    });

    res.json({ success: true, order: finalOrder });
  } catch (error: any) {
    res.status(error?.statusCode || 500).json({ code: error?.code, error: error?.code === "ORDER_REQUEST_CHANGED" ? error.message : safeCheckoutFailure(error).error });
  }
});

app.post("/api/orders/:id/cancel", requireCustomerAuth, async (req, res) => {
  const id = String(req.params.id || "");
  if (!validPaymentReference(id)) return res.status(400).json({ success: false, code: "INVALID_REFERENCE", error: "Invalid order reference." });
  const orderRef = db.collection("orders").doc(id);
  try {
    await db.runTransaction(async (transaction: any) => {
      const snapshot = await transaction.get(orderRef);
      if (!snapshot.exists || snapshot.data()?.userId !== res.locals.uid) throw Object.assign(new Error("Order not found."), { statusCode: 404 });
      const order = snapshot.data() || {};
      if (isFinalPaymentStatus(order.paymentStatus)) throw Object.assign(new Error("A settled order cannot be cancelled online. Contact the restaurant for help."), { statusCode: 409 });
      if (!['pending', 'cancel_requested', 'cancelled'].includes(order.status)) throw Object.assign(new Error("This order is already being prepared. Contact the restaurant to request a change."), { statusCode: 409 });
      const uncertainOnline = order.paymentMethod === "chapa" && !hasDefinitiveChapaFailure(order);
      const status = uncertainOnline ? "cancel_requested" : "cancelled";
      const now = new Date().toISOString();
      if (status === order.status) return;
      const promoFields = uncertainOnline ? {} : await releaseOrderPromotion(transaction, db, order);
      transaction.update(orderRef, { ...promoFields, status, ...(uncertainOnline ? { cancelRequestedAt: now } : {}), updatedAt: now, statusHistory: [...(Array.isArray(order.statusHistory) ? order.statusHistory : []), { status, at: now }] });
    });
    let order = (await orderRef.get()).data() || {};
    if (order.status === "cancel_requested") {
      try {
        const verification = await callChapaVerify(id);
        const payment = verification?.data;
        if (verifiedPaymentMatchesOrder(payment, order, id)) {
          await markChapaOrderPaid(orderRef, payment);
        } else if (String(payment?.status || "").toLowerCase() === "success") {
          await markChapaVerificationConflict(orderRef, "verified_details_mismatch");
        } else {
          // A failed hosted attempt remains payable. Expire it at Chapa before
          // making a new reference possible; a local cancel alone is unsafe.
          await cancelChapaTransaction(id, getCleanEnv("CHAPA_SECRET_KEY"));
          await recordProviderCancellation(orderRef);
        }
      } catch (error: any) {
        if (error?.providerReason === "unpaid") {
          try {
            await cancelChapaTransaction(id, getCleanEnv("CHAPA_SECRET_KEY"));
            await recordProviderCancellation(orderRef);
          } catch { /* Outcome remains uncertain: keep cancel_requested. */ }
        }
      }
      order = (await orderRef.get()).data() || order;
    }
    return res.json({ success: true, status: order.status, order: customerOrderSummary(orderRef.id, order) });
  } catch (error: any) {
    return res.status(error?.statusCode || 500).json({ success: false, code: error?.statusCode === 404 ? "ORDER_NOT_FOUND" : "ORDER_CANCEL_REJECTED", error: error?.statusCode ? error.message : "Could not cancel this order." });
  }
});

app.patch("/api/orders/:id", requireStaffAuth, async (req, res) => {
  try {
    const orderRef = db.collection("orders").doc(req.params.id);
    let dispatch = false;
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(orderRef);
      if (!snapshot.exists) throw Object.assign(new Error("Order not found."), { statusCode: 404 });
      const current = snapshot.data() || {};
      const permissions = await resolveStaffPermissions(String(res.locals.token.email || ""), transaction);
      const updates = buildStaffOrderUpdate(current, req.body, permissions, new Date().toISOString());
      if (Object.keys(updates).length) transaction.update(orderRef, updates);
      dispatch = updates.status === "dispatched" && !["pickup", "dineIn"].includes(current.fulfillmentType);
    });
    if (dispatch) await triggerShipday(req.params.id, db, req.body.deliveryMinutes);
    const latest = await orderRef.get();
    res.json({ success: true, order: { id: latest.id, ...latest.data() } });
  } catch (error: any) {
    res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : "Failed to update order." });
  }
});

// Chapa's documented standard checkout API. The API secret authorizes payment
// requests; the webhook secret independently authenticates webhook deliveries.
const CHAPA_API_BASE = "https://api.chapa.co/v1";

// API version is selected by the endpoint, not the key prefix.
function hasConfiguredChapaSecret(value: string): boolean {
  return !isMissingOrPlaceholderSecret(value);
}

function requireStaffPermission(permission: string) {
  return (req: any, res: any, next: any) => {
    const staff = res.locals.staff;
    if (!staffHas(staff, permission)) return res.status(403).json({ error: "Forbidden: your role cannot perform this action." });
    next();
  };
}

function requireStaffAnyPermission(permissions: string[]) {
  return (_req: any, res: any, next: any) => {
    if (!permissions.some(permission => staffHas(res.locals.staff, permission))) return res.status(403).json({ error: "Forbidden: your role cannot perform this action." });
    next();
  };
}



const checkoutMenuCache = new Map<string, { expiresAt: number; data: any | null }>();
db.onChange(({ collections }) => {
  if (collections.includes("menu")) checkoutMenuCache.clear();
  if (collections.includes("settings")) checkoutSettingsCache = null;
});
// A very short cache lets an immediate retry reuse menu reads that finished
// just after the prior request deadline, without keeping prices stale long-term.
const CHECKOUT_MENU_CACHE_MS = 3000;

async function loadCheckoutMenuItems(ids: string[]): Promise<Map<string, any | null>> {
  const now = Date.now();
  const result = new Map<string, any | null>();
  const missing: string[] = [];
  for (const id of ids) {
    const cached = checkoutMenuCache.get(id);
    if (cached && cached.expiresAt > now) result.set(id, cached.data);
    else missing.push(id);
  }
  if (missing.length) {
    const refs = missing.map(id => db.collection("menu").doc(id));
    const snapshots = typeof db.getAll === "function"
      ? await db.getAll(...refs)
      : await Promise.all(refs.map((ref: any) => ref.get()));
    const expiresAt = Date.now() + CHECKOUT_MENU_CACHE_MS;
    snapshots.forEach((snapshot: any, index: number) => {
      const id = missing[index];
      const data = snapshot.exists ? snapshot.data() : null;
      checkoutMenuCache.set(id, { expiresAt, data });
      result.set(id, data);
    });
  }
  return result;
}

async function calculateChapaOrder(orderData: any, recordStage?: (stage: string, durationMs: number) => void) {
  if (!Array.isArray(orderData.items) || orderData.items.length === 0) {
    throw checkoutValidationError("CHECKOUT_CART_EMPTY");
  }
  if (orderData.items.length > 50) {
    throw checkoutValidationError("CHECKOUT_CART_TOO_LARGE");
  }

  const fulfillmentType = ["delivery", "pickup", "dineIn"].includes(orderData.fulfillmentType) ? orderData.fulfillmentType : "delivery";
  const menuIds = orderData.items.map((line: any) => {
    const raw = line && line.menuItem ? line.menuItem : line;
    return raw && (raw.id || raw.menuItemId);
  });
  if (menuIds.some((id: any) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(id))) {
    throw checkoutValidationError("CHECKOUT_INVALID_ITEM");
  }

  const uniqueMenuIds = Array.from(new Set<string>(menuIds.map((id: any) => String(id))));
  const promoCode = orderData.promoCode ? String(orderData.promoCode).trim().toUpperCase() : null;
  if (promoCode && !/^[A-Z0-9_-]{1,80}$/.test(promoCode)) throw checkoutValidationError("CHECKOUT_PROMO_CHANGED");
  const timedRead = <T>(stage: string, read: () => Promise<T>): Promise<T> => {
    const readStartedAt = Date.now();
    return Promise.resolve().then(read).finally(() => recordStage?.(stage, Date.now() - readStartedAt));
  };
  const [checkoutCfg, menuSnapshots, promoSnapshot] = await Promise.all([
    timedRead("pricing_settings", () => getCheckoutSettings(db)),
    timedRead("pricing_menu", () => loadCheckoutMenuItems(uniqueMenuIds)),
    timedRead("pricing_promo", () => promoCode ? db.collection("promoCodes").doc(promoCode).get() : Promise.resolve(null))
  ]);
  const schedule = scheduleAcceptsOrders(checkoutCfg);
  const accepting = checkoutCfg.scheduleEnabled ? schedule.accepting : checkoutCfg.isOpen !== false;
  if (!accepting) throw checkoutValidationError("CHECKOUT_RESTAURANT_CLOSED");

  const menuById = menuSnapshots;

  const recomputedItems: any[] = [];
  let subtotal = 0;
  for (let index = 0; index < orderData.items.length; index++) {
    const line = orderData.items[index];
    const raw = line && line.menuItem ? line.menuItem : line;
    const menuItemId = String(menuIds[index]);
    const menuData = menuById.get(menuItemId);
    if (!menuData) {
      throw checkoutValidationError("CHECKOUT_ITEM_UNAVAILABLE");
    }
    if (menuData.isActive === false) throw checkoutValidationError("CHECKOUT_ITEM_UNAVAILABLE");

    const quantity = Number(line && line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw checkoutValidationError("CHECKOUT_INVALID_QUANTITY");
    }

    let unitPrice = Number(menuData.price);
    const menuVariations = Array.isArray(menuData.variations) ? menuData.variations : [];
    const rawVariationId = (line && line.variationId) || (raw && raw.variationId);
    const variationId = rawVariationId ? String(rawVariationId) : null;
    let variation: any = null;
    if (menuVariations.length > 0) {
      variation = variationId ? menuVariations.find((candidate: any) => candidate && String(candidate.id) === variationId) : null;
      if (variationId && !variation) throw checkoutValidationError("CHECKOUT_VARIANT_UNAVAILABLE");
      if (!variation) variation = menuVariations.find((candidate: any) => candidate && candidate.isDefault && candidate.isAvailable !== false);
      if (!variation) variation = menuVariations.find((candidate: any) => candidate && candidate.isAvailable !== false);
      if (!variation || variation.isAvailable === false) {
        throw checkoutValidationError("CHECKOUT_VARIANT_UNAVAILABLE");
      }
      const variationPrice = Number(variation.price);
      if (!Number.isFinite(variationPrice) || variationPrice < 0) {
        throw checkoutValidationError("CHECKOUT_INVALID_PRICE");
      }
      unitPrice = variationPrice;
    } else if (variationId) {
      throw checkoutValidationError("CHECKOUT_VARIANT_UNAVAILABLE");
    }

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw checkoutValidationError("CHECKOUT_INVALID_PRICE");
    }
    subtotal += unitPrice * quantity;
    const { variations: _variations, ...menuItemSnapshot } = menuData;
    const itemSnapshot: any = { ...menuItemSnapshot, id: menuData.id || menuItemId, price: unitPrice };
    if (variation) itemSnapshot.variation = { id: String(variation.id), label: variation.label || "" };
    recomputedItems.push({ menuItem: itemSnapshot, quantity, variationId: variation ? String(variation.id) : null });
  }

  const taxPercent = Number(checkoutCfg.serviceTaxPercent ?? 0);
  const configuredFee = Number(checkoutCfg.flatFeeETB ?? 0);
  if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100 || !Number.isFinite(configuredFee) || configuredFee < 0 || configuredFee > 9999999.99) throw checkoutValidationError("CHECKOUT_SETTINGS_UNAVAILABLE", 503);
  const serviceTax = Math.round(subtotal * taxPercent) / 100;
  const flatFee = fulfillmentType === "delivery" ? configuredFee : 0;
  let discountAmount = 0;
  if (promoCode) {
    if (!promoSnapshot?.exists) throw checkoutValidationError("CHECKOUT_PROMO_CHANGED");
    const promo = promoSnapshot.data();
    if (!promotionCapacity(promo)) throw checkoutValidationError("CHECKOUT_PROMO_LIMIT_REACHED");
    discountAmount = promotionDiscount(promo, subtotal);
  }

  const total = Math.max(0, Math.round((subtotal + serviceTax + flatFee - discountAmount) * 100) / 100);
  if (!Number.isFinite(total) || total <= 0) {
    throw checkoutValidationError("CHECKOUT_INVALID_TOTAL");
  }

  return {
    items: recomputedItems,
    fulfillmentType,
    scheduledFor: normalizeScheduledFor(orderData.scheduledFor, checkoutCfg.prepTimeMinutes || 30),
    total,
    serviceTax,
    flatFee,
    promoCode,
    discountAmount
  };
}

const verifyChapaReference = createChapaVerificationClient(() => getCleanEnv("CHAPA_SECRET_KEY"));
async function callChapaVerify(txRef: string) { return verifyChapaReference(txRef); }

function hasDefinitiveChapaFailure(order: any): boolean {
  return hasConfirmedChapaFailure(order);
}

function isChapaTerminalFailure(status: unknown, order?: any): boolean {
  // Failed/cancelled bank attempts can be retried in the same hosted checkout.
  // Only our acknowledged irreversible provider cancel proves it unpayable.
  return Boolean(order?.providerCancelledAt) && /^(?:cancelled|canceled)$/.test(String(status || "").trim().toLowerCase());
}

async function recordProviderCancellation(orderRef: any) {
  await db.runTransaction(async (transaction: any) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists || isFinalPaymentStatus(snapshot.data()?.paymentStatus)) return;
    const order = snapshot.data();
    const now = new Date().toISOString();
    const promoFields = await releaseOrderPromotion(transaction, db, order);
    transaction.update(orderRef, { ...promoFields, status: "cancelled", providerCancelledAt: now, paymentAttemptStatus: "cancelled", failureDefinitive: true, paymentInitError: false, failureReason: "This checkout was cancelled and expired at Chapa.", updatedAt: now, statusHistory: [...(Array.isArray(order.statusHistory) ? order.statusHistory : []), { status: "cancelled", at: now }] });
  });
}

async function recoverLegacyChapaFailure(orderRef: any, order: any) {
  if (order.paymentMethod !== "chapa" || isFinalPaymentStatus(order.paymentStatus) || order.failureDefinitive !== true || hasDefinitiveChapaFailure(order)) return order;
  await db.runTransaction(async (transaction: any) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists || isFinalPaymentStatus(snapshot.data()?.paymentStatus)) return;
    const current = snapshot.data();
    if (hasDefinitiveChapaFailure(current)) return;
    const now = new Date().toISOString();
    transaction.update(orderRef, { paymentAttemptStatus: "reconciling", failureDefinitive: false, failureReason: "We’re checking the previous payment before starting another.", ...(current.status === "cancelled" ? { status: "pending", statusHistory: [...(Array.isArray(current.statusHistory) ? current.statusHistory : []), { status: "pending", at: now }] } : {}), updatedAt: now });
  });
  return (await orderRef.get()).data() || order;
}

function chapaPaymentMatchDiagnostics(payment: any, order: any, txRef: string, responseStatus = "success") {
  return securePaymentDiagnostics(payment, order, txRef, getCleanEnv("CHAPA_SECRET_KEY"), responseStatus);
}

function chapaPaymentIdentityMatchesOrder(payment: any, order: any, txRef: string, responseStatus = "success"): boolean {
  const diagnostics = chapaPaymentMatchDiagnostics(payment, order, txRef, responseStatus);
  return diagnostics.responseStatus === "success" && diagnostics.providerTxRefMatches && diagnostics.amountMatches && diagnostics.currencyMatches && diagnostics.modeMatches;
}

function verifiedPaymentMatchesOrder(payment: any, order: any, txRef: string): boolean {
  return chapaPaymentMatchDiagnostics(payment, order, txRef).matches;
}

function customerOrderSummary(id: string, order: any) {
  return {
    id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentAttemptStatus: order.paymentAttemptStatus || "initializing",
    paymentMethod: order.paymentMethod,
    failureDefinitive: hasDefinitiveChapaFailure(order),
    failureReason: order.failureReason || "",
    paymentReconciliationRequired: order.paymentReconciliationRequired === true,
    total: order.total,
    transactionRef: order.transactionRef || id,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

async function markChapaAttemptFailed(orderRef: any, attemptStatus: string, reason: string, chapaReference = "", definitive = false) {
  const now = new Date().toISOString();
  await db.runTransaction(async (transaction: any) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) return;
    const order = snapshot.data() || {};
    if (isFinalPaymentStatus(order.paymentStatus)) return;
    if (order.failureDefinitive === true) return;
    if (order.paymentReconciliationRequired === true && !definitive) return;
    const history = Array.isArray(order.paymentHistory) ? order.paymentHistory : [];
    const nextOrderStatus = definitive ? "cancelled" : order.status;
    transaction.update(orderRef, {
      paymentStatus: "pending",
      paymentAttemptStatus: definitive ? "failed" : attemptStatus,
      failureDefinitive: definitive,
      paymentInitError: false,
      failureReason: reason,
      ...(chapaReference ? { chapaReference } : {}),
      updatedAt: now,
      ...(definitive ? {
        paymentReconciliationRequired: false,
        paymentVerificationIssue: "",
        reconciliationResolvedAt: now,
        status: nextOrderStatus,
        statusHistory: [...(Array.isArray(order.statusHistory) ? order.statusHistory : []), { status: nextOrderStatus, at: now }]
      } : {}),
      paymentHistory: [...history, { paymentStatus: "pending", attemptStatus, at: now }]
    });
  });
}

async function markChapaVerificationConflict(orderRef: any, issue: "provider_status_conflict" | "verified_details_mismatch") {
  const now = new Date().toISOString();
  await db.runTransaction(async (transaction: any) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists || isFinalPaymentStatus(snapshot.data()?.paymentStatus)) return;
    const order = snapshot.data() || {};
    const previousStatus = order.status;
    const nextStatus = previousStatus === "cancelled" ? "pending" : previousStatus;
    transaction.update(orderRef, {
      paymentStatus: "pending",
      paymentAttemptStatus: "reconciling",
      failureDefinitive: false,
      paymentReconciliationRequired: true,
      paymentVerificationIssue: issue,
      providerSuccessEventAt: order.providerSuccessEventAt || now,
      failureReason: "Chapa sent a success notification, but its verification result does not agree yet. Do not pay again while we check it.",
      ...(nextStatus !== previousStatus ? {
        status: nextStatus,
        statusHistory: [...(Array.isArray(order.statusHistory) ? order.statusHistory : []), { status: nextStatus, at: now }]
      } : {}),
      updatedAt: now
    });
  });
}

async function markChapaOrderPaid(orderRef: any, payment: any) {
  let changed = false;
  const now = new Date().toISOString();
  await db.runTransaction(async (transaction: any) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists || isFinalPaymentStatus(snapshot.data()?.paymentStatus)) return;
    const order = snapshot.data();
    assertVerifiedChapaSettlement(payment, order, orderRef.id, getCleanEnv("CHAPA_SECRET_KEY"));
    const promoFields = await completeOrderPromotion(transaction, db, order);
    const customer = payment.customer || {};
    const reference = String(payment.reference || payment.ref_id || payment.chapa_reference || order.chapaReference || "");
    const activeStatus = order.status && !["cancelled", "cancel_requested"].includes(order.status) ? order.status : "pending";
    const receipt = {
      transactionId: reference,
      reference,
      amount: Number(payment.amount),
      currency: String(payment.currency || "ETB").toUpperCase(),
      paymentMethod: payment.method || payment.payment_method || "Chapa",
      fullName: ((payment.first_name || customer.first_name || "") + " " + (payment.last_name || customer.last_name || "")).trim() || order.customerName || "",
      email: payment.email || customer.email || order.customerEmail || "",
      date: payment.updated_at || payment.created_at || now,
      status: "success",
      simulated: false
    };
    transaction.update(orderRef, {
      ...promoFields,
      paymentStatus: "completed",
      status: activeStatus,
      chapaReference: reference,
      paymentAttemptStatus: "success",
      failureDefinitive: false,
      paymentReconciliationRequired: false,
      paymentVerificationIssue: "",
      failureReason: "",
      receipt,
      updatedAt: now,
      statusHistory: Array.isArray(order.statusHistory) ? [...order.statusHistory, { status: activeStatus, at: now }] : [{ status: activeStatus, at: now }],
      paymentHistory: Array.isArray(order.paymentHistory) ? [...order.paymentHistory, { paymentStatus: "completed", at: now }] : [{ paymentStatus: "completed", at: now }]
    });
    changed = true;
  });
  return changed;
}

/** A signed adjustment event pauses fulfillment until the API confirms it. */
async function reconcileChapaAdjustment(orderRef: any, verification: any, adjustmentExpected = false): Promise<boolean> {
  const payment = verification?.data;
  const providerStatus = typeof payment?.status === "string" ? payment.status.trim().toLowerCase() : "";
  if (!adjustmentExpected && !isChapaAdjustmentStatus(providerStatus)) return false;
  await db.runTransaction(async (transaction: any) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) return;
    const order = snapshot.data() || {};
    const fields = buildChapaAdjustmentReconciliation(payment, order, orderRef.id, getCleanEnv("CHAPA_SECRET_KEY"), verification?.status || "", adjustmentExpected);
    if (fields && Object.keys(fields).length) transaction.update(orderRef, fields);
  });
  return true;
}

installDatabaseApi(app, db, { verifyToken: verifyFirebaseToken, resolveStaffPermissions, primaryAdminEmail: PRIMARY_ADMIN_EMAIL });

app.get("/health", (_req, res) => res.status(200).json({ status: "ok", database: "sqlite", checkoutFlow: CHECKOUT_FLOW_VERSION }));

app.get("/ready", async (_req, res) => {
  try {
    await db.collection("settings").doc("checkout").get();
    res.status(200).json({ status: "ready", database: "sqlite" });
  } catch {
    res.status(503).json({ status: "not_ready" });
  }
});

app.get("/api/chapa/webhook", (_req, res) => {
  const webhookSecret = getCleanEnv("CHAPA_WEBHOOK_SECRET");
  res.json({
    status: isMissingOrPlaceholderSecret(webhookSecret) ? "unconfigured" : "ready",
    endpoint: "/api/chapa/webhook"
  });
});

app.post("/api/chapa/webhook", async (req: any, res) => {
  try {
    const webhookSecret = getCleanEnv("CHAPA_WEBHOOK_SECRET");
    if (isMissingOrPlaceholderSecret(webhookSecret)) return res.status(503).send("Webhook secret is not configured.");
    if (!assertChapaWebhookSignature(req.rawBody, req.get("x-chapa-signature"), req.get("chapa-signature"), webhookSecret)) {
      console.warn("[CHAPA WEBHOOK] Rejected request with an invalid or missing signature.");
      return res.status(401).send("Invalid signature");
    }

    const event = req.body || {};
    const txRef = String(event.tx_ref || event.trx_ref || event.merchant_reference || "").trim();
    const chapaReference = String(event.reference || event.ref_id || event.chapa_reference || "").trim();
    const eventName = String(event.event || "").toLowerCase();
    if (event.webhook_type && String(event.webhook_type).toLowerCase() !== "payment") {
      return res.status(200).send("Non-payment event ignored");
    }
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(txRef)) {
      return res.status(400).send("Invalid transaction reference");
    }

    const orderRef = db.collection("orders").doc(txRef);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      console.warn("[CHAPA WEBHOOK] Signed event references unknown order " + txRef + ".");
      return res.status(503).send("Order is not available yet.");
    }
    const order = orderSnap.data();
    const adjustmentEvent = /^(?:charge|payment)\.(?:refunding|refunded|reversed)$/.test(eventName) ||
      ["refunding", "refunded", "reversed"].includes(String(event.status || "").toLowerCase());
    if (adjustmentEvent) {
      try {
        await reconcileChapaAdjustment(orderRef, await callChapaVerify(txRef), true);
      } catch {
        await reconcileChapaAdjustment(orderRef, null, true);
        return res.status(503).send("Payment adjustment verification is temporarily unavailable.");
      }
      return res.status(200).send("Webhook received; payment adjustment checked");
    }
    if (isFinalPaymentStatus(order.paymentStatus)) return res.status(200).send("Webhook received");

    if (["charge.success", "payment.success"].includes(eventName) || String(event.status || "").toLowerCase() === "success") {
      const verification = await callChapaVerify(txRef);
      const payment = verification && verification.data;
      const diagnostic = chapaPaymentMatchDiagnostics(payment, order, txRef, verification?.status);
      if (!diagnostic.matches) {
        const verifiedTerminalFailure = String(verification?.status || "").toLowerCase() === "success" &&
          isChapaTerminalFailure(payment?.status, order) && chapaPaymentIdentityMatchesOrder(payment, order, txRef, verification?.status);
        if (verifiedTerminalFailure) {
          await markChapaAttemptFailed(orderRef, String(payment.status).toLowerCase(), "Chapa verified that this checkout did not complete. You can retry payment.", String(payment.reference || payment.ref_id || ""), true);
          console.warn(JSON.stringify({ event: "chapa_webhook_success_overruled_by_verify_failure", txRef, eventName, ...diagnostic }));
          return res.status(200).send("Webhook received; verification confirms payment did not complete");
        }
        await markChapaVerificationConflict(orderRef, isChapaTerminalFailure(payment?.status, order) ? "provider_status_conflict" : "verified_details_mismatch");
        console.warn(JSON.stringify({ event: "chapa_webhook_verification_mismatch", txRef, eventName, ...diagnostic }));
        // The signed event has been handled. Re-delivery cannot fix a provider/data mismatch;
        // browser return verification and the order listener continue reconciliation.
        return res.status(200).send("Webhook received; payment remains unconfirmed");
      }
      await markChapaOrderPaid(orderRef, payment);
      console.log("[CHAPA WEBHOOK] Payment confirmed for order " + txRef + ".");
      return res.status(200).send("Webhook received");
    }

    const attemptStatus = String(event.status || eventName || "pending").toLowerCase();
    if (/(failed|cancelled|canceled|blocked|incomplete)/.test(attemptStatus)) {
      await markChapaAttemptFailed(orderRef, attemptStatus, "Payment was not completed. You can try again.", chapaReference);
      return res.status(200).send("Webhook received");
    }

    // Failed attempts can be retried in hosted checkout, so leave the order pending.
    return res.status(200).send("Webhook received");
  } catch (error: any) {
    console.error("[CHAPA WEBHOOK] Processing failed:", error?.statusCode || "provider or network error");
    return res.status(error && error.statusCode || 500).send("Webhook processing failed");
  }
});

app.get("/api/chapa/callback", async (req, res) => {
  const txRef = String(req.query.trx_ref || req.query.tx_ref || req.query.merchant_reference || req.query.order_id || "").trim();
  let status = "pending";
  if (/^[a-zA-Z0-9_-]{1,120}$/.test(txRef)) {
    try {
      const orderRef = db.collection("orders").doc(txRef);
      const orderSnap = await orderRef.get();
      if (orderSnap.exists) {
        const order = orderSnap.data() || {};
        const verification = await callChapaVerify(txRef);
        const payment = verification && verification.data;
        const diagnostic = chapaPaymentMatchDiagnostics(payment, order, txRef, verification?.status);
        if (await reconcileChapaAdjustment(orderRef, verification, order.paymentVerificationIssue === "payment_adjustment_unconfirmed")) {
          status = String((await orderRef.get()).data()?.paymentStatus || "pending");
        } else if (diagnostic.matches) {
          await markChapaOrderPaid(orderRef, payment);
          status = "success";
        } else if (String(verification?.status || "").toLowerCase() === "success" && String(payment?.status || "").toLowerCase() === "success") {
          await markChapaVerificationConflict(orderRef, "verified_details_mismatch");
        } else if (isChapaTerminalFailure(payment?.status, order)) {
          if (String(verification?.status || "").toLowerCase() === "success" && chapaPaymentIdentityMatchesOrder(payment, order, txRef, verification?.status)) {
            await markChapaAttemptFailed(orderRef, String(payment.status).toLowerCase(), "Chapa confirmed that this checkout did not complete. Your cart is ready for a new payment attempt.", String(payment.reference || payment.ref_id || ""), true);
            status = "failed";
          } else {
            await markChapaVerificationConflict(orderRef, "provider_status_conflict");
          }
        }
      }
    } catch (error: any) {
      console.warn("[CHAPA CALLBACK] Could not verify return yet:", error?.statusCode || "verification unavailable");
    }
  }
  if (!txRef) return res.redirect("/?payment_return=1&status=pending");
  return res.redirect("/?payment_return=1&status=" + status + "&tx_ref=" + encodeURIComponent(txRef));
});

function requestBaseUrl(req: any): string { return requestOrigin(req, APP_PUBLIC_ORIGIN, PRODUCTION); }

app.post("/api/chapa/initialize", requireCustomerAuth, customerOrderLimit, async (req, res) => {
  const checkoutRequest: any = req;
  const body = req.body || {};
  let orderRef: any = null;
  let order: any = null;
  let attemptToken = "";
  const startedAt = Number((req as any).requestStartedAt) || Date.now();
  const deadlineAt = startedAt + CHECKOUT_REQUEST_DEADLINE_MS;
  let txRef = "";
  let timedOutStage = "";
  const stageMs: Record<string, number> = {};
  const runStage = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const stageStartedAt = Date.now();
    try {
      return await withinDeadline(Promise.resolve().then(operation), deadlineAt, stage);
    } catch (error: any) {
      if (error?.name === "TimeoutError") timedOutStage = error.stage || stage;
      throw error;
    } finally {
      stageMs[stage] = Date.now() - stageStartedAt;
    }
  };
  let chapaStartedAt = 0;
  let chapaMs = 0;
  let pricingMs = 0;
  let claimMs = 0;
  let persistenceMs = 0;
  try {
    const email = String(body.email || "").trim();
    const firstName = String(body.first_name || "").trim();
    const lastName = String(body.last_name || "").trim();
    if (!firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith("@example.com")) {
    return res.status(400).json({ success: false, code: "CHECKOUT_INVALID_FIELDS", error: "Enter your first name, last name, and a valid email address.", retryAction: "new_reference" });
    }
    if (firstName.length > 35 || lastName.length > 35 || email.length > 50) {
      return res.status(400).json({ success: false, code: "CHECKOUT_INVALID_FIELDS", error: "Keep each name to 35 characters and the email address to 50 characters or fewer.", retryAction: "new_reference" });
    }

    const secretKey = getCleanEnv("CHAPA_SECRET_KEY");
    if (!hasConfiguredChapaSecret(secretKey)) {
    return res.status(503).json({ success: false, code: "CHAPA_NOT_CONFIGURED", error: "Chapa API key is not configured on the server.", retryAction: "wait" });
    }

    const requestId = String(body.clientRequestId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    if (requestId.length < 24) return res.status(400).json({ success: false, code: "INVALID_REQUEST_ID", error: "Refresh checkout and try again.", retryAction: "new_reference" });
    txRef = "PAY-" + requestId;
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(txRef)) return res.status(400).json({ success: false, code: "INVALID_REQUEST_ID", error: "Invalid payment request identifier.", retryAction: "new_reference" });

    if (body.userId && body.userId !== res.locals.uid) {
      return res.status(403).json({ success: false, code: "AUTH_ACCOUNT_MISMATCH", error: "Checkout account does not match your session.", retryAction: "wait" });
    }

    const customerPhone = chapaPhoneNumber(body.phone_number);
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({
      items: body.items,
      fulfillmentType: body.fulfillmentType,
      scheduledFor: body.scheduledFor || null,
      promoCode: body.promoCode || null,
      email,
      firstName,
      lastName,
      phone: customerPhone || "",
      blockNumber: body.blockNumber || "",
      roomNumber: body.roomNumber || "",
      googleMapsAddress: body.googleMapsAddress || "",
      specialInstructions: body.specialInstructions || ""
    })).digest("hex");
    orderRef = db.collection("orders").doc(txRef);
    const now = new Date().toISOString();
    const existing: any = await runStage<any>("order_lookup", () => orderRef.get());
    if (existing.exists) {
      order = existing.data() || {};
      if (order.userId !== res.locals.uid) return res.status(404).json({ success: false, code: "PAYMENT_NOT_FOUND", error: "Payment attempt not found." });
      order = await recoverLegacyChapaFailure(orderRef, order);
      if (isFinalPaymentStatus(order.paymentStatus)) return res.status(409).json({ success: false, code: "PAYMENT_ALREADY_COMPLETED", error: "This order has already been paid.", txRef, retryAction: "wait" });
      if (order.paymentReconciliationRequired === true || order.fulfillmentHoldReason) return res.status(202).json({ success: false, code: "CHAPA_RECONCILING", error: "Your payment needs verification. Do not pay again while we check it.", txRef, retryAction: "wait" });
      if (order.paymentRequestHash && order.paymentRequestHash !== requestHash) {
        const definitive = hasDefinitiveChapaFailure(order);
        const failure = safeCheckoutFailure(checkoutValidationError(definitive ? "PAYMENT_REQUEST_CHANGED" : "PAYMENT_PREVIOUS_ATTEMPT_OPEN", 409));
        return res.status(409).json({ success: false, ...failure, txRef, retryAction: definitive ? "new_reference" : "wait" });
      }
      if (isChapaCheckoutUrl(order.chapaCheckoutUrl) && order.paymentStatus === "pending" && order.failureDefinitive !== true && !["cancelled", "cancel_requested"].includes(order.status)) return res.json({ success: true, recovered: true, txRef, checkoutUrl: order.chapaCheckoutUrl, order: customerOrderSummary(txRef, order) });
    } else {
      const pricingStartedAt = Date.now();
      const pricing = await runStage("pricing", () => calculateChapaOrder(body, (stage, durationMs) => { stageMs[stage] = durationMs; }));
      pricingMs = Date.now() - pricingStartedAt;
      order = {
        id: txRef,
        items: pricing.items,
        status: "pending",
        total: pricing.total,
        customerName: (firstName + " " + lastName).trim(),
        customerEmail: email,
        customerPhone: customerPhone || "",
        blockNumber: body.fulfillmentType === "delivery" ? String(body.blockNumber || "") : "",
        roomNumber: body.fulfillmentType === "delivery" ? String(body.roomNumber || "") : "",
        googleMapsAddress: body.fulfillmentType === "delivery" ? String(body.googleMapsAddress || "") : "",
        specialInstructions: String(body.specialInstructions || ""),
        paymentMethod: "chapa",
        paymentStatus: "pending",
        paymentAttemptStatus: "initializing",
        fulfillmentType: pricing.fulfillmentType,
        scheduledFor: pricing.scheduledFor || null,
        transactionRef: txRef,
        paymentRequestHash: requestHash,
        createdAt: now,
        updatedAt: now,
        userId: res.locals.uid,
        clientRequestId: requestId,
        attemptVersion: 0,
        serviceTax: pricing.serviceTax,
        flatFee: pricing.flatFee,
        promoCode: pricing.promoCode,
        discountAmount: pricing.discountAmount,
        statusHistory: [{ status: "pending", at: now }],
        paymentHistory: [{ paymentStatus: "pending", attemptStatus: "initializing", at: now }]
      };
    }

    attemptToken = crypto.randomUUID();
    const nowMs = Date.now();
    // Bound the lease to the request start, not the end of a slow pricing or
    // database stage. A late claim then becomes recoverable shortly after the
    // request deadline instead of locking the reference for another 35 seconds.
    const leaseExpiresAt = startedAt + CHECKOUT_ATTEMPT_LEASE_MS;
    const claimStartedAt = Date.now();
    let claim: any = null;
    const claimExistingOrder = () => db.runTransaction(async (transaction: any) => {
      const orderSnap = await transaction.get(orderRef);
      if (orderSnap.exists) {
        const current = orderSnap.data() || {};
        if (current.userId !== res.locals.uid) throw Object.assign(new Error("Payment attempt not found."), { statusCode: 404, code: "PAYMENT_NOT_FOUND" });
        if (isFinalPaymentStatus(current.paymentStatus)) { claim = { completed: true, order: current }; return; }
        if (current.paymentReconciliationRequired === true || current.fulfillmentHoldReason) { claim = { reconciling: true, order: current }; return; }
        if (current.paymentRequestHash && current.paymentRequestHash !== requestHash) throw Object.assign(checkoutValidationError(hasDefinitiveChapaFailure(current) ? "PAYMENT_REQUEST_CHANGED" : "PAYMENT_PREVIOUS_ATTEMPT_OPEN", 409), { retryAction: hasDefinitiveChapaFailure(current) ? "new_reference" : "wait" });
        if (current.status === "cancel_requested") { claim = { reconciling: true, order: current }; return; }
        if (isChapaCheckoutUrl(current.chapaCheckoutUrl) && current.paymentStatus === "pending" && current.failureDefinitive !== true && !["cancelled", "cancel_requested"].includes(current.status)) { claim = { checkoutUrl: current.chapaCheckoutUrl, order: current }; return; }
        if (current.paymentAttemptStatus === "initializing") {
          claim = Number(current.leaseExpiresAt || 0) > nowMs
            ? { inProgress: true, order: current }
            : { reconciling: true, order: current };
          return;
        }
        if (current.paymentAttemptStatus === "reconciling" || current.paymentAttemptStatus === "initialization_unknown") { claim = { reconciling: true, order: current }; return; }
        if (current.paymentAttemptStatus === "failed" && hasDefinitiveChapaFailure(current)) throw Object.assign(new Error("This payment attempt was rejected. Start a new payment attempt."), { statusCode: 409, code: "PAYMENT_ATTEMPT_ENDED" });
        const promoFields = await reserveOrderPromotion(transaction, db, current);
        const version = (Number(current.attemptVersion) || 0) + 1;
        transaction.update(orderRef, { ...promoFields, paymentAttemptStatus: "initializing", attemptToken, attemptVersion: version, leaseExpiresAt, paymentInitError: false, updatedAt: new Date().toISOString() });
        claim = { order: { ...current, ...promoFields }, version };
      } else {
        await assertNewChapaAttemptCapacity(transaction, db, res.locals.uid);
        const promoFields = await reserveOrderPromotion(transaction, db, order);
        const createdOrder = { ...order, ...promoFields, attemptToken, attemptVersion: 1, leaseExpiresAt, paymentAttemptStatus: "initializing" };
        transaction.create(orderRef, createdOrder);
        claim = { order: createdOrder, version: 1 };
        order = createdOrder;
      }
    });

    if (existing.exists) {
      await runStage("claim", claimExistingOrder);
    } else {
      const createdOrder = { ...order, attemptToken, attemptVersion: 1, leaseExpiresAt, paymentAttemptStatus: "initializing" };
      try {
        await runStage("claim", () => db.runTransaction(async (transaction: any) => {
          const current = await transaction.get(orderRef);
          if (current.exists) throw Object.assign(new Error("Payment attempt already exists."), { code: "already-exists" });
          await assertNewChapaAttemptCapacity(transaction, db, res.locals.uid);
          const promoFields = await reserveOrderPromotion(transaction, db, createdOrder);
          Object.assign(createdOrder, promoFields);
          transaction.create(orderRef, createdOrder);
        }));
        claim = { order: createdOrder, version: 1 };
        order = createdOrder;
      } catch (claimError: any) {
        const claimCode = String(claimError?.code || claimError?.statusCode || "").toLowerCase();
        if (["6", "409", "already_exists", "already-exists"].includes(claimCode)) {
          return res.status(202).json({ success: false, code: "INITIALIZATION_IN_PROGRESS", error: "We’re checking your payment request. Tap Pay Online again to safely resume.", txRef, retryAction: "wait" });
        }
        throw claimError;
      }
    }
    claimMs = Date.now() - claimStartedAt;
    if (claim?.completed) return res.status(409).json({ success: false, code: "PAYMENT_ALREADY_COMPLETED", error: "This order has already been paid.", txRef, retryAction: "wait" });
    if (claim?.checkoutUrl) return res.json({ success: true, recovered: true, txRef, checkoutUrl: claim.checkoutUrl, order: customerOrderSummary(txRef, claim.order) });
    if (claim?.inProgress || claim?.reconciling) return res.status(202).json({ success: false, code: claim.reconciling ? "CHAPA_RECONCILING" : "INITIALIZATION_IN_PROGRESS", error: "We’re checking your payment request. Tap Pay Online again to safely resume.", txRef, retryAction: "wait" });
    order = { ...claim.order, attemptVersion: claim.version };

    const nameParts = String(order.customerName || "").trim().split(/\s+/);
    const chapaEmail = String(order.customerEmail || email).trim();
    const chapaFirstName = nameParts[0] || firstName;
    const chapaLastName = nameParts.slice(1).join(" ") || lastName;
    const chapaAmount = Number(Number(order.total).toFixed(2));
    if (!Number.isFinite(chapaAmount) || chapaAmount <= 0 || chapaAmount > 9999999.99) {
      throw Object.assign(new Error("This order total is outside Chapa's accepted amount range."), { statusCode: 400, code: "CHAPA_INVALID_AMOUNT" });
    }
    if (chapaEmail.length > 50 || chapaFirstName.length > 35 || chapaLastName.length > 35) {
      throw Object.assign(new Error("The customer name or email exceeds Chapa's accepted length."), { statusCode: 400, code: "CHECKOUT_INVALID_FIELDS" });
    }
    const requestOrigin = requestBaseUrl(req);
    const isLocalRequestOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(requestOrigin);
    // Chapa must be able to reach the callback. When local checkout is opened
    // on localhost, use the configured public tunnel for callbacks while
    // returning the customer's browser to the same local origin.
    const callbackBaseUrl = process.env.NODE_ENV === "development" && isLocalRequestOrigin
      ? resolveBaseUrl(req)
      : requestOrigin;
    const callbackUrl = callbackBaseUrl + "/api/chapa/callback";
    const returnUrl = requestOrigin + "/?payment_return=1&tx_ref=" + encodeURIComponent(txRef);
    const chapaPayload: any = {
      // Chapa's validation guide requires a JSON number (its accept-payment
      // example uses a string); send the numeric type to satisfy validation.
      amount: chapaAmount,
      currency: "ETB",
      email: chapaEmail,
      first_name: chapaFirstName,
      last_name: chapaLastName,
      tx_ref: txRef,
      callback_url: callbackUrl,
      return_url: returnUrl,
      customization: createChapaCustomization(txRef, (await getCheckoutSettings(db)).restaurantName),
      // Keep to Chapa's documented fields. The unique tx_ref already maps the
      // payment to this order, so an undocumented custom meta key is redundant.
    };
    if (customerPhone) chapaPayload.phone_number = customerPhone;

    const remainingDeadlineMs = CHECKOUT_REQUEST_DEADLINE_MS - (Date.now() - startedAt);
    if (remainingDeadlineMs <= 0) throw Object.assign(new Error("Payment initialization deadline reached."), { name: "TimeoutError" });
    chapaStartedAt = Date.now();
    const response = await runStage("chapa", () => fetch(CHAPA_API_BASE + "/transaction/initialize", {
      method: "POST", redirect: "error",
      headers: { "Authorization": "Bearer " + secretKey, "Content-Type": "application/json" },
      body: JSON.stringify(chapaPayload),
      signal: AbortSignal.timeout(Math.min(15000, remainingDeadlineMs))
    }));
    let chapaData: any = {};
    let invalidGatewayJson = false;
    try { chapaData = await runStage("chapa_body", () => readChapaJsonResponse(response)); }
    catch (error: any) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw error;
      invalidGatewayJson = true;
      chapaData = { message: "Chapa returned an invalid response." };
    }
    chapaMs = Date.now() - chapaStartedAt;
    const checkoutUrl = chapaData && chapaData.data && chapaData.data.checkout_url || chapaData && chapaData.checkout_url;
    if (!response.ok || String(chapaData && chapaData.status || "").toLowerCase() !== "success" ||
        !isChapaCheckoutUrl(checkoutUrl)) {
      const failure = invalidGatewayJson || response.ok
        ? { code: "CHAPA_INVALID_RESPONSE", message: "Chapa returned an unreadable response. We’re checking the payment request before retrying.", retryAction: "wait" as const, reasonClass: "invalid_response" }
        : mapChapaFailure(response.status, chapaData);
      const message = failure.message;
      const failurePersistenceStartedAt = Date.now();
      await runStage("failure_persist", () => db.runTransaction(async (transaction: any) => {
        const snap = await transaction.get(orderRef);
        if (!snap.exists || snap.data()?.attemptToken !== attemptToken || isFinalPaymentStatus(snap.data()?.paymentStatus)) return;
        const uncertain = response.status >= 500 || failure.retryAction === "wait";
        const definitive = !uncertain && failure.retryAction === "new_reference";
        const promoFields = definitive ? await releaseOrderPromotion(transaction, db, snap.data()) : {};
        transaction.update(orderRef, { ...promoFields, paymentInitError: false, paymentAttemptStatus: uncertain ? "reconciling" : "failed", failureDefinitive: definitive, ...(definitive ? { initializationRejectedAt: new Date().toISOString() } : {}), failureReason: message, leaseExpiresAt: uncertain ? Date.now() + CHECKOUT_ATTEMPT_LEASE_MS : 0, updatedAt: new Date().toISOString() });
      }));
      persistenceMs = Date.now() - failurePersistenceStartedAt;
      console.info(JSON.stringify({ event: "chapa_initialize", txRef, attemptVersion: order.attemptVersion, amountType: typeof chapaPayload.amount, callbackHostKind: isLocalRequestOrigin && callbackBaseUrl !== requestOrigin ? "configured_public_origin" : (isLocalRequestOrigin ? "local" : "public_request_origin"), phoneIncluded: !!chapaPayload.phone_number, bodyBytes: checkoutRequest.checkoutBodyBytes, bodyMs: Number(checkoutRequest.checkoutBodyParsedAt || startedAt) - Number(checkoutRequest.checkoutBodyStartedAt || startedAt), authMs: res.locals.authMs, pricingMs, claimMs, httpStatus: response.status, chapaMs, persistenceMs, stageMs, totalMs: Date.now() - startedAt, code: failure.code, reasonClass: failure.reasonClass, providerHint: process.env.NODE_ENV === "development" ? safeChapaDiagnostic(chapaData, [secretKey, txRef, chapaEmail, chapaFirstName, chapaLastName, customerPhone, String(chapaAmount), callbackUrl, returnUrl]) : undefined }));
      return res.status(response.status >= 500 ? 502 : (response.status === 401 ? 502 : 400)).json({ success: false, code: failure.code, error: message, txRef, retryAction: failure.retryAction });
    }

    const persistenceStartedAt = Date.now();
    await runStage("persistence", () => db.runTransaction(async (transaction: any) => {
      const snap = await transaction.get(orderRef);
      if (!snap.exists || snap.data()?.attemptToken !== attemptToken || isFinalPaymentStatus(snap.data()?.paymentStatus)) throw checkoutValidationError("PAYMENT_ATTEMPT_CHANGED", 409);
      if (snap.data()?.paymentReconciliationRequired === true || snap.data()?.fulfillmentHoldReason) throw Object.assign(checkoutValidationError("PAYMENT_RECONCILIATION_REQUIRED", 409), { retryAction: "wait" });
      transaction.update(orderRef, {
      chapaCheckoutUrl: checkoutUrl,
      checkoutReturnUrl: returnUrl,
      paymentInitError: false,
      paymentAttemptStatus: "ready",
      leaseExpiresAt: 0,
      failureReason: "",
      updatedAt: new Date().toISOString()
      });
    }));
    persistenceMs = Date.now() - persistenceStartedAt;
    order = { ...order, chapaCheckoutUrl: checkoutUrl, checkoutReturnUrl: returnUrl, paymentInitError: false, paymentAttemptStatus: "ready", failureReason: "" };
    console.info(JSON.stringify({ event: "chapa_initialize", txRef, attemptVersion: order.attemptVersion, amountType: typeof chapaPayload.amount, callbackHostKind: isLocalRequestOrigin && callbackBaseUrl !== requestOrigin ? "configured_public_origin" : (isLocalRequestOrigin ? "local" : "public_request_origin"), phoneIncluded: !!chapaPayload.phone_number, bodyBytes: checkoutRequest.checkoutBodyBytes, bodyMs: Number(checkoutRequest.checkoutBodyParsedAt || startedAt) - Number(checkoutRequest.checkoutBodyStartedAt || startedAt), authMs: res.locals.authMs, pricingMs, claimMs, httpStatus: response.status, chapaMs, persistenceMs, stageMs, totalMs: Date.now() - startedAt }));
    return res.json({ success: true, mode: "hosted", checkoutUrl, txRef, order: customerOrderSummary(txRef, order) });
  } catch (error: any) {
    const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
    const transportError = timedOut || !error?.statusCode;
    const failedBeforeProvider = !chapaStartedAt && ["auth", "order_lookup", "pricing", "claim"].includes(String(timedOutStage || error?.stage || ""));
    const retryAction = error?.retryAction === "wait" ? "wait" : failedBeforeProvider
      ? "same_reference"
      : ["PAYMENT_ATTEMPT_ENDED", "PAYMENT_REQUEST_CHANGED"].includes(String(error?.code || ""))
      ? "new_reference"
      : (transportError ? "wait" : "same_reference");
    if (orderRef && order && order.paymentStatus === "pending" && attemptToken && error?.code !== "PAYMENT_RECONCILIATION_REQUIRED") {
      void db.runTransaction(async (transaction: any) => {
        const snap = await transaction.get(orderRef);
        if (!snap.exists || snap.data()?.attemptToken !== attemptToken || isFinalPaymentStatus(snap.data()?.paymentStatus)) return;
        const uncertain = !failedBeforeProvider && transportError;
        transaction.update(orderRef, { paymentInitError: false, paymentAttemptStatus: uncertain ? "reconciling" : "failed", failureDefinitive: !failedBeforeProvider && !transportError && retryAction === "new_reference", failureReason: failedBeforeProvider ? "Chapa was not contacted. This payment reference is safe to retry." : (uncertain ? "Payment initialization outcome is being checked." : "Payment initialization failed."), leaseExpiresAt: uncertain ? Date.now() + CHECKOUT_ATTEMPT_LEASE_MS : 0, updatedAt: new Date().toISOString() });
      }).catch(() => {});
    }
    const statusCode = error && error.statusCode || (timedOut ? 504 : 502);
    const localFailure = safeCheckoutFailure(error);
    const code = failedBeforeProvider ? "CHECKOUT_PRE_PROVIDER_TIMEOUT" : (timedOut ? "CHAPA_TIMEOUT" : (transportError ? "CHAPA_NETWORK_ERROR" : localFailure.code));
    const safeError = failedBeforeProvider
      ? "Checkout details took too long to validate. Chapa was not contacted; retry safely."
      : transportError
        ? "We’re checking your payment request. Tap Pay Online again to safely resume."
        : localFailure.error;
    console.error(JSON.stringify({ event: "chapa_initialize_error", txRef: order?.id || txRef || undefined, attemptVersion: order?.attemptVersion, bodyBytes: checkoutRequest.checkoutBodyBytes, bodyMs: Number(checkoutRequest.checkoutBodyParsedAt || startedAt) - Number(checkoutRequest.checkoutBodyStartedAt || startedAt), timedOutStage: timedOutStage || error?.stage || null, stageMs, authMs: res.locals.authMs, totalMs: Date.now() - startedAt, timedOut: !!timedOut, statusCode, code }));
    return res.status(statusCode).json({
      success: false,
      code,
      txRef: order?.id || txRef || undefined,
      retryAction,
      error: safeError
    });
  }
});

app.get("/api/chapa/attempt/:txRef", requireCustomerAuth, async (req, res) => {
  const txRef = String(req.params.txRef || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(txRef)) return res.status(400).json({ success: false, code: "INVALID_REFERENCE", error: "Invalid payment reference." });
  const orderRef = db.collection("orders").doc(txRef);
  try {
    const snapshot = await orderRef.get();
    if (!snapshot.exists) return res.status(404).json({ success: false, code: "PAYMENT_NOT_FOUND", error: "No payment record was saved yet. Tap Pay Online again to safely resume this checkout.", txRef, retryAction: "same_reference" });
    if (snapshot.data()?.userId !== res.locals.uid) return res.status(404).json({ success: false, code: "PAYMENT_NOT_FOUND", error: "Payment attempt not found." });
    let order = await recoverLegacyChapaFailure(orderRef, snapshot.data() || {});
    const staleInitialization = order.paymentAttemptStatus === "initializing" && Number(order.leaseExpiresAt || 0) <= Date.now();
    if (staleInitialization) {
      // A timed-out SQLite write can commit after the initialize request has
      // already returned. Recover that persisted claim instead of leaving it
      // stuck forever in "initializing".
      await db.runTransaction(async (transaction: any) => {
        const currentSnap = await transaction.get(orderRef);
        if (!currentSnap.exists || currentSnap.data()?.userId !== res.locals.uid || isFinalPaymentStatus(currentSnap.data()?.paymentStatus)) return;
        const current = currentSnap.data() || {};
        if (current.paymentAttemptStatus === "initializing" && Number(current.leaseExpiresAt || 0) <= Date.now()) {
          transaction.update(orderRef, { paymentAttemptStatus: "reconciling", paymentInitError: false, failureDefinitive: false, failureReason: "We’re checking whether Chapa received this payment request.", updatedAt: new Date().toISOString() });
        }
      });
      order = (await orderRef.get()).data() || order;
    }
    if ((!isFinalPaymentStatus(order.paymentStatus) || order.paymentStatus === "completed" && order.paymentReconciliationRequired === true) && (order.paymentAttemptStatus === "reconciling" || order.status === "cancel_requested" || order.paymentReconciliationRequired === true)) {
      try {
        const verification = await callChapaVerify(txRef);
        const payment = verification?.data;
        if (await reconcileChapaAdjustment(orderRef, verification, order.paymentVerificationIssue === "payment_adjustment_unconfirmed")) {
          order = (await orderRef.get()).data() || order;
        } else if (String(verification?.status || "").toLowerCase() === "success" && String(payment?.status || "").toLowerCase() === "success") {
          if (!verifiedPaymentMatchesOrder(payment, order, txRef)) {
            await markChapaVerificationConflict(orderRef, "verified_details_mismatch");
            order = (await orderRef.get()).data() || order;
          } else {
          await markChapaOrderPaid(orderRef, payment);
          order = (await orderRef.get()).data() || order;
          }
        } else if (payment) {
          const providerStatus = String(payment.status || "").toLowerCase();
          if (isChapaTerminalFailure(providerStatus, order)) {
            if (String(verification?.status || "").toLowerCase() === "success" && chapaPaymentIdentityMatchesOrder(payment, order, txRef, verification?.status)) {
              await markChapaAttemptFailed(orderRef, providerStatus, "Chapa confirmed that this checkout did not complete. Your cart is ready for a new payment attempt.", String(payment.reference || payment.ref_id || ""), true);
            } else {
              await markChapaVerificationConflict(orderRef, "provider_status_conflict");
            }
            order = (await orderRef.get()).data() || order;
          }
        }
      } catch (verifyError: any) {
        const invalidReference = verifyError?.providerReason === "not_found";
        if (invalidReference) {
          const now = Date.now();
          let allowNew = false;
          await db.runTransaction(async (transaction: any) => {
            const currentSnap = await transaction.get(orderRef);
            if (!currentSnap.exists || isFinalPaymentStatus(currentSnap.data()?.paymentStatus)) return;
            const current = currentSnap.data() || {};
            const checks = Number(current.reconciliationNotFoundChecks) || 0;
            const lastCheck = Number(current.lastReconciliationNotFoundAt) || 0;
            const separated = checks > 0 && now - lastCheck >= 5000;
            const nextChecks = separated ? checks + 1 : (checks ? checks : 1);
            allowNew = nextChecks >= 2 && Number(current.leaseExpiresAt || 0) < now;
            const nextOrderStatus = allowNew && ["pending", "cancel_requested"].includes(current.status) ? "cancelled" : current.status;
            const statusHistory = Array.isArray(current.statusHistory) ? current.statusHistory : [];
            const promoFields = allowNew ? await releaseOrderPromotion(transaction, db, current) : {};
            transaction.update(orderRef, { ...promoFields, reconciliationNotFoundChecks: nextChecks, lastReconciliationNotFoundAt: now, ...(allowNew ? { paymentAttemptStatus: "failed", failureDefinitive: true, providerNotFoundConfirmedAt: new Date(now).toISOString(), paymentInitError: false, paymentReconciliationRequired: false, paymentVerificationIssue: "", reconciliationResolvedAt: new Date(now).toISOString(), failureReason: "Chapa confirmed that this payment reference does not exist.", ...(nextOrderStatus !== current.status ? { status: nextOrderStatus, statusHistory: [...statusHistory, { status: nextOrderStatus, at: new Date(now).toISOString() }] } : {}) } : {}) });
          });
          if (allowNew) order = (await orderRef.get()).data() || order;
        }
      }
    }
    const current = await orderRef.get();
    order = current.data() || order;
    return res.json({ success: true, status: order.paymentReconciliationRequired ? "reconciling" : isFinalPaymentStatus(order.paymentStatus) ? order.paymentStatus : order.paymentAttemptStatus || "pending", txRef, checkoutUrl: order.paymentStatus !== "pending" || order.paymentReconciliationRequired || order.fulfillmentHoldReason || ["cancel_requested", "cancelled"].includes(order.status) || hasDefinitiveChapaFailure(order) || !isChapaCheckoutUrl(order.chapaCheckoutUrl) ? null : order.chapaCheckoutUrl, retryAction: isFinalPaymentStatus(order.paymentStatus) ? "wait" : order.paymentAttemptStatus === "failed" && hasDefinitiveChapaFailure(order) ? "new_reference" : "wait", order: customerOrderSummary(txRef, order) });
  } catch (error: any) {
    return res.status(500).json({ success: false, code: "ATTEMPT_LOOKUP_FAILED", error: "Could not check this payment attempt yet." });
  }
});

app.get("/api/chapa/verify/:txRef", requireCustomerAuth, async (req, res) => {
  try {
    const txRef = String(req.params.txRef || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(txRef)) return res.status(400).json({ success: false, error: "Invalid payment reference." });

    const orderRef = db.collection("orders").doc(txRef);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists || orderSnap.data()?.userId !== res.locals.uid) return res.status(404).json({ success: false, status: "not_found" });
    const order = orderSnap.data();
    if (isFinalPaymentStatus(order.paymentStatus) && !(order.paymentStatus === "completed" && order.paymentReconciliationRequired === true)) {
      return res.json({ success: order.paymentStatus === "completed", status: order.paymentStatus, order: customerOrderSummary(orderSnap.id, order) });
    }

    const verification = await callChapaVerify(txRef);
    const payment = verification && verification.data;
    if (await reconcileChapaAdjustment(orderRef, verification, order.paymentVerificationIssue === "payment_adjustment_unconfirmed")) {
      const updated = await orderRef.get();
      const current = updated.data() || order;
      return res.json({ success: false, status: current.paymentReconciliationRequired ? "reconciling" : current.paymentStatus, paymentReconciliationRequired: current.paymentReconciliationRequired === true, order: customerOrderSummary(updated.id, current) });
    }
    if (String(verification && verification.status || "").toLowerCase() !== "success" || !payment) {
      return res.json({ success: false, status: order.paymentReconciliationRequired ? "reconciling" : (order.paymentAttemptStatus || "pending"), paymentReconciliationRequired: order.paymentReconciliationRequired === true, order: customerOrderSummary(orderSnap.id, order) });
    }

    if (String(payment.status || "").toLowerCase() === "success") {
      if (!verifiedPaymentMatchesOrder(payment, order, txRef)) {
        const diagnostic = chapaPaymentMatchDiagnostics(payment, order, txRef, verification?.status);
        await markChapaVerificationConflict(orderRef, "verified_details_mismatch");
        console.warn(JSON.stringify({ event: "chapa_verify_reconciliation_required", txRef, ...diagnostic }));
        return res.status(409).json({ success: false, status: "reconciling", code: "PAYMENT_DETAILS_MISMATCH", paymentReconciliationRequired: true, error: "Chapa reported a successful payment, but one detail needs reconciliation. Do not pay again while we check it." });
      }
      await markChapaOrderPaid(orderRef, payment);
      const updated = await orderRef.get();
      return res.json({ success: true, status: "completed", order: customerOrderSummary(updated.id, updated.data()) });
    }

    const gatewayStatus = String(payment.status || "pending").toLowerCase();
    if (isChapaTerminalFailure(gatewayStatus, order) && order.paymentStatus !== "completed") {
      const reference = String(payment.reference || payment.ref_id || payment.chapa_reference || "");
      if (chapaPaymentIdentityMatchesOrder(payment, order, txRef, verification?.status)) {
        await markChapaAttemptFailed(orderRef, gatewayStatus, "Chapa confirmed that this checkout did not complete. Your cart is ready for a new payment attempt.", reference, true);
      } else {
        const diagnostic = chapaPaymentMatchDiagnostics(payment, order, txRef, verification?.status);
        await markChapaVerificationConflict(orderRef, "provider_status_conflict");
        console.warn(JSON.stringify({ event: "chapa_verify_failure_details_mismatch", txRef, ...diagnostic }));
        return res.status(409).json({ success: false, status: "reconciling", code: "PAYMENT_DETAILS_MISMATCH", paymentReconciliationRequired: true, error: "Chapa returned conflicting payment details. Do not pay again while we check them." });
      }
    }
    const updated = await orderRef.get();
    const updatedOrder = updated.data() || {};
    return res.json({ success: false, status: updatedOrder.paymentReconciliationRequired ? "reconciling" : (updatedOrder.paymentAttemptStatus || "pending"), failureDefinitive: updatedOrder.failureDefinitive === true, paymentReconciliationRequired: updatedOrder.paymentReconciliationRequired === true, gatewayStatus, order: customerOrderSummary(updated.id, updatedOrder) });
  } catch (error: any) {
    console.error("[CHAPA VERIFY] Could not verify payment:", error?.statusCode || "provider or network error");
    return res.status(error && error.statusCode || 502).json({ success: false, status: "pending", error: "Payment verification is temporarily unavailable." });
  }
});
// 3. Checkout Settings Endpoints
app.get("/api/settings", async (req, res) => {
  try {
    const settingsRef = db.collection("settings").doc("checkout");
    const docSnap = await settingsRef.get();
    if (docSnap.exists) {
      const data = docSnap.data();
      res.json({
        restaurantName: data.restaurantName ?? "",
        logoUrl: data.logoUrl ?? "",
        businessEmail: data.businessEmail ?? "",
        businessPhone: data.businessPhone ?? "",
        businessAddress: data.businessAddress ?? "",
        serviceTaxPercent: data.serviceTaxPercent ?? 15,
        flatFeeETB: data.flatFeeETB ?? 0,
        shipdayDeliveryMinutes: data.shipdayDeliveryMinutes ?? 20,
        isOpen: data.isOpen ?? true,
        scheduleEnabled: data.scheduleEnabled ?? false,
        openTime: data.openTime ?? "09:00",
        closeTime: data.closeTime ?? "22:00",
        enableCOD: data.enableCOD ?? true,
        prepTimeMinutes: data.prepTimeMinutes ?? 30,
        scheduledStepsMinutes: data.scheduledStepsMinutes ?? 15
      });
    } else {
      res.json({
        restaurantName: "",
        logoUrl: "",
        businessEmail: "",
        businessPhone: "",
        businessAddress: "",
        serviceTaxPercent: 15,
        flatFeeETB: 0,
        shipdayDeliveryMinutes: 20,
        isOpen: true,
        scheduleEnabled: false,
        openTime: "09:00",
        closeTime: "22:00",
        prepTimeMinutes: 30,
        scheduledStepsMinutes: 15
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch checkout settings" });
  }
});

app.post("/api/settings", requireStaffAuth, requireStaffPermission("settings.edit"), async (req, res) => {
  try {
    const settings = { ...validatedCheckoutSettings(req.body), updatedAt: new Date().toISOString() };
    await db.collection("settings").doc("checkout").set(settings, { merge: true });
    checkoutSettingsCache = null;
    res.json({ success: true, settings });
  } catch (error: any) {
    res.status(error?.statusCode || 500).json({ error: error?.statusCode === 400 ? error.message : "Failed to save checkout settings." });
  }
});

// Business Data Export & Clear
// Collects every business-relevant collection into a single JSON object so the
// owner can take a full snapshot before wiping. The /clear route is the
// destructive counterpart and requires the typed "CLEAR MY DATA" confirmation.
const BUSINESS_COLLECTIONS = [
  "settings",
  "categories",
  "menu",
  "orders",
  "reservations",
  "promoCodes",
  "users",
  "admins",
  "roles",
  "audit_log"
];

async function dumpBusinessData(): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  for (const name of BUSINESS_COLLECTIONS) {
    try {
      const snap = await db.collection(name).get();
      out[name] = snap.docs.map(d => ({ id: d.id, ...(name === "settings" ? redactServerSecrets(d.data()) : d.data()) }));
    } catch (err: any) {
      console.warn(`[BUSINESS EXPORT] Failed to read ${name}:`, err?.message);
      out[name] = [];
    }
  }
  return out;
}

app.get("/api/business/export", requireStaffAuth, async (req, res) => {
  try {
    const email = res.locals?.token?.email;
    const permCtx = await resolveStaffPermissions(email);
    if (!staffHas(permCtx, "data.export")) {
      return res.status(403).json({ error: "Forbidden: Your role does not have permission to download business data." });
    }
    const payload = await dumpBusinessData();
    const body = {
      exportedAt: new Date().toISOString(),
      exportedBy: email || "unknown",
      source: "savory",
      collections: payload
    };
    const settings = await getCheckoutSettings(db);
    const businessSlug = typeof settings.restaurantName === "string"
      ? settings.restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
      : "";
    const filename = `${businessSlug ? businessSlug + "-" : ""}business-data-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(body, null, 2));
  } catch (error: any) {
    res.status(500).json({ error: "Failed to export business data" });
  }
});

app.post("/api/business/clear", requireStaffAuth, async (req, res) => {
  try {
    const email = res.locals?.token?.email;
    const permCtx = await resolveStaffPermissions(email);
    if (!staffHas(permCtx, "data.clear")) {
      return res.status(403).json({ error: "Forbidden: Your role does not have permission to clear business data." });
    }
    const confirmText = String(req.body?.confirm || "").trim();
    if (confirmText !== "CLEAR MY DATA") {
      return res.status(400).json({ error: "Confirmation phrase is incorrect. Type 'CLEAR MY DATA' exactly." });
    }

    // 1) Pre-log a final audit entry FIRST so there is a record of the wipe.
    try {
      await db.collection("audit_log").add({
        actorEmail: email || "unknown",
        actorRole: permCtx?.role || "unknown",
        action: "Cleared business data",
        category: "settings",
        targetId: null,
        details: { scope: "full-nuclear", initiatedBy: email || "unknown" },
        createdAt: new Date().toISOString()
      });
    } catch (e: any) {
      console.warn("[BUSINESS CLEAR] Could not pre-write audit entry:", e?.message);
    }

    // Preserve the server-configured primary login when clearing business data.
    const counts: Record<string, number> = {};
    for (const name of BUSINESS_COLLECTIONS) {
      let removed = 0;
      try {
        const snap = await db.collection(name).get();
        const docs = snap.docs.filter(document => !isPrimaryAdminProtectedPath(document.ref.path, PRIMARY_ADMIN_EMAIL));
        for (let i = 0; i < docs.length; i += 500) {
          const batch = db.batch();
          docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
        removed = docs.length;
      } catch (err: any) {
        console.warn(`[BUSINESS CLEAR] Failed to clear ${name}:`, err?.message);
      }
      counts[name] = removed;
    }

    // 3) Reset settings documents to a sensible default so the site keeps
    //    booting instead of throwing on a missing document.
    const defaultSettings = {
      restaurantName: "",
      logoUrl: "",
      businessEmail: "",
      businessPhone: "",
      businessAddress: "",
      serviceTaxPercent: 15,
      flatFeeETB: 0,
      enableCOD: true,
      isOpen: true,
      scheduleEnabled: false,
      openTime: "09:00",
      closeTime: "22:00",
      enableMarketing: true,
      enableReservations: true,
      enableChatbot: true,
      prepTimeMinutes: 30,
      scheduledStepsMinutes: 15,
      updatedAt: new Date().toISOString()
    };
    try { await db.collection("settings").doc("global").set(defaultSettings); } catch (e: any) { console.warn("[BUSINESS CLEAR] Could not reset settings/global:", e?.message); }
    try { await db.collection("settings").doc("checkout").set(defaultSettings); } catch (e: any) { console.warn("[BUSINESS CLEAR] Could not reset settings/checkout:", e?.message); }

    res.json({ success: true, counts, clearedAt: new Date().toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to clear business data" });
  }
});

// Customer Management Endpoints
app.get("/api/customers", requireStaffAuth, requireStaffPermission("customers.view"), async (req, res) => {
  try {
    const snapshot = await db.collection("users").get();
    const customers = snapshot.docs.map(doc => ({ uid: doc.id, id: doc.id, ...doc.data() }));
    res.json(customers);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch customers" });
  }
});

// Mailchimp Connection Test Endpoint
app.get("/api/mailchimp/test", requireStaffAuth, requireStaffPermission("settings.edit"), async (req, res) => {
  try {
    const apiKey = process.env.MAILCHIMP_API_KEY;
    const listId = process.env.MAILCHIMP_LIST_ID;

    if (!apiKey || !listId || apiKey === "YOUR_MAILCHIMP_API_KEY") {
      return res.status(400).json({
        success: false,
        error: "Mailchimp is not configured in the environment variables."
      });
    }

    const datacenter = apiKey.split("-")[1] || "us1";
    if (!/^us[0-9]{1,3}$/.test(datacenter)) return res.status(400).json({ success: false, error: "Mailchimp configuration is invalid." });
    const mailchimpUrl = `https://${datacenter}.api.mailchimp.com/3.0/lists/${encodeURIComponent(listId)}`;

    const response = await fetch(mailchimpUrl, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: {
        "Authorization": `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`,
        "Content-Type": "application/json"
      }
    });

    const data: any = await response.json();

    if (response.ok) {
      res.json({ success: true, message: `Connected to Mailchimp! List: ${data.name}` });
    } else {
      res.status(400).json({ success: false, error: data.title || "Mailchimp connection failed" });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: "The integration connection test failed." });
  }
});

// Provider webhooks and staff dispatch use associated, stored orders only.
installShipdayRoutes(app, shipdayService, { requireStaffAuth, requireStaffPermission });
app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

// Vite or Static Files Handler
async function startServer() {
  await initializeLocalData(db, appRoot);
  await syncPrimaryAdmin(db, PRIMARY_ADMIN_EMAIL);
  console.log("[DATABASE] SQLite ready; business data is stored locally.");
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: path.join(appRoot, "frontend"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("[VITE] Mounted dev middleware successfully");
  } else {
    const distPath = path.join(appRoot, "frontend", "dist");
    app.use(express.static(distPath, { dotfiles: "deny", index: false }));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use(safeApiError);
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] Ready! on http://localhost:${PORT}`);
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;
  server.on("error", (error: any) => {
    console.error(error?.code === "EADDRINUSE"
      ? `[SERVER] Port ${PORT} is busy. Stop the previous server before restarting so your tunnel stays on the same port.`
      : "[SERVER] Could not start the HTTP server.");
    db.close();
    process.exit(1);
  });

}

startServer().catch((error: any) => {
  console.error("[SERVER] Startup failed:", error?.message || "Unknown startup error");
  db.close();
  process.exit(1);
});
