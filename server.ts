/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import axios from "axios";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

dotenv.config();

let firebaseConfig: any = {
  apiKey: process.env.VITE_FIREBASE_API_KEY || "",
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || "",
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: process.env.VITE_FIREBASE_APP_ID || "",
  measurementId: process.env.VITE_FIREBASE_MEASUREMENT_ID || ""
};

try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    const configRaw = fs.readFileSync(configPath, "utf-8");
    firebaseConfig = { ...firebaseConfig, ...JSON.parse(configRaw) };
  }
} catch (e) {
  console.warn("Could not load firebase-applet-config.json", e);
}

const appFirebase = initializeApp({
  credential: applicationDefault(),
  projectId: firebaseConfig.projectId
});
const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(appFirebase, firebaseConfig.firestoreDatabaseId)
  : getFirestore(appFirebase);
// Note: In typical GCP containers, ADC defaults to default DB. If you created a custom DB ID,
// you might need `admin.firestore({ databaseId: 'ai-studio-restaurantwebsit-315fb01e-8f08-42d3-b0aa-03636feabfef' })`.
// Wait, the documentation for custom DB in admin SDK is tricky, we can just fetch collections.
// Actually, `admin.firestore()` will hit the default DB unless initialized with custom config.
// Let's use the default DB for the backend or specify the databaseId if possible.
// Wait, AI Studio Firebase sets up the DB. I'll rely on the client SDK reading from the right one, 
// and the server syncing with the default ADC (which usually works out of the box in AI Studio).

const app = express();
const PORT = 3000;

// Capture the exact raw request body for the Chapa webhook so we can verify
// the HMAC SHA256 payload signature (must run before express.json parses it).
app.use((req: any, _res, next) => {
  if (req.path === "/api/chapa/webhook") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks).toString("utf8");
      next();
    });
    req.on("error", next);
  } else {
    next();
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Middleware: require a valid Firebase ID token for admin/staff-only routes.
// Token is read from the `Authorization: Bearer <idToken>` header, with a
// fallback to `x-firebase-token` header / `token` query param for non-browser callers.
async function requireStaffAuth(req: any, res: any, next: any) {
  try {
    const header = (req.headers?.authorization as string) || "";
    let token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token && req.headers?.["x-firebase-token"]) {
      token = String(req.headers["x-firebase-token"]).trim();
    }
    if (!token && req.query?.token) {
      token = String(req.query.token).trim();
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized: Missing Firebase ID token." });
    }

    const decodedToken = await getAuth(appFirebase).verifyIdToken(token);
    res.locals.uid = decodedToken.uid;
    res.locals.token = decodedToken;
    next();
  } catch (error: any) {
    console.warn("[AUTH] Firebase ID token verification failed:", error?.code || error?.message);
    return res.status(401).json({ error: "Unauthorized: Invalid or expired Firebase ID token." });
  }
}

// True when an env secret is unset or still a known dev placeholder. Webhook /
// callback routes use this to FAIL CLOSED instead of silently skipping verification.
function isMissingOrPlaceholderSecret(value?: string): boolean {
  const secret = (value || "").trim();
  if (!secret) return true;
  const placeholders = [
    "MY_CHAPA_WEBHOOK_SECRET",
    "YOUR_CHAPA_WEBHOOK_SECRET",
    "MY_SHIPDAY_WEBHOOK_TOKEN",
    "YOUR_SHIPDAY_WEBHOOK_TOKEN",
    "CHAPASECKEY-xxxx",
    "SHIPDAY_WEBHOOK_TOKEN_XXXX"
  ];
  const upper = secret.toUpperCase();
  return placeholders.some((p) => upper.includes(p)) || /xxxx/i.test(secret);
}

// Helper to trigger Shipday order creation
async function triggerShipday(orderId: string, db: any, deliveryMinutes?: number) {
  try {
    // Fetch settings first to get API Key and Pickup Lead Time
    const settingsSnap = await db.collection("settings").doc("checkout").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};

    const shipdayKey = process.env.SHIPDAY_API_KEY || settings.shipdayApiKey;
    const pickupLeadTime = settings.shipdayPickupMinutes || 10;

    if (!shipdayKey) {
      console.warn(`[SHIPDAY] Skip: API key not configured for order ${orderId}`);
      return;
    }

    const orderRef = db.collection("orders").doc(orderId);
    const docSnap = await orderRef.get();
    if (!docSnap.exists) return;

    const orderData = docSnap.data();

    console.log(`[SHIPDAY] Triggering order ${orderId} (Delivery: ${deliveryMinutes || 'auto'}, Pickup Lead: ${pickupLeadTime})...`);

    const payload: any = {
      orderNumber: orderId,
      customerName: orderData.customerName,
      customerAddress: orderData.googleMapsAddress || orderData.blockNumber || "No address provided",
      customerEmail: orderData.customerEmail,
      customerPhoneNumber: orderData.customerPhone,
      restaurantName: "Savory VPS",
      restaurantAddress: "Addis Ababa, Ethiopia",
      orderItems: orderData.items.map((item: any) => ({
        name: item.menuItem?.name || item.name || "Menu Item",
        unitPrice: item.menuItem?.price || item.price || 0,
        quantity: item.quantity || 1
      })),
      totalOrderCost: orderData.total,
      deliveryFee: orderData.flatFee || 0,
      tax: orderData.serviceTax || 0,
      paymentMethod: orderData.paymentMethod === 'cash' ? 'cash' : 'credit_card',
      paymentType: orderData.paymentMethod === 'cash' ? 'cash' : 'credit_card'
    };

    const shipdayResponse = await axios.post(
      "https://api.shipday.com/orders",
      payload,
      {
        headers: {
          "Authorization": "Basic " + shipdayKey,
          "Content-Type": "application/json"
        }
      }
    );

    const data = shipdayResponse.data;
    if (data && data.orderId) {
      await orderRef.update({
        shipdayOrderId: data.orderId,
        shipdayStatus: "created",
        shipdayTrackingLink: data.trackingLink || data.shortTrackingLink || null,
        shipdaySyncedAt: new Date().toISOString()
      });
      console.log(`[SHIPDAY] Order ${orderId} synced successfully (Shipday ID: ${data.orderId})`);
    }
  } catch (error: any) {
    console.error(`[SHIPDAY] Error in triggerShipday for ${orderId}:`, error.response?.data || error.message);
  }
}


async function getCheckoutSettings(db: any) {
  try {
    const snap = await db.collection("settings").doc("checkout").get();
    return snap.exists ? snap.data() : {};
  } catch (e) {
    return {};
  }
}

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


async function applyPromo(orderData: any, db: any) {
  try {
    if (orderData.promoCode) {
      const promoRef = db.collection("promoCodes").doc(orderData.promoCode);
      const promoSnap = await promoRef.get();
      if (promoSnap.exists) {
        const promo = promoSnap.data();
        await promoRef.update({ usageCount: (promo.usageCount || 0) + 1 });
      }
    }
  } catch (error) {
    console.error("[PROMO] Error applying promo:", error);
  }
}

// 0. Category Endpoints
app.get("/api/categories", async (req, res) => {
  try {
    const snapshot = await db.collection("categories").get();
    const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(categories);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch categories", details: error.message });
  }
});

app.post("/api/categories", requireStaffAuth, async (req, res) => {
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
    res.status(500).json({ error: "Failed to create category", details: error.message });
  }
});

app.delete("/api/categories/:id", requireStaffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("categories").doc(id).delete();

    const snapshot = await db.collection("categories").get();
    const categories = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, categories });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete category", details: error.message });
  }
});

// 1. Menu Endpoints
app.get("/api/menu", async (req, res) => {
  try {
    const snapshot = await db.collection("menu").get();
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(menu);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch menu items", details: error.message });
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
      prepTime: item.prepTime || "15 mins",
      ingredients: item.ingredients || [],
      nutrition: item.nutrition || { protein: "0g", carbs: "0g", fat: "0g" },
      basePrice: item.basePrice !== undefined ? item.basePrice : item.price,
      taxRate: item.taxRate || "Food Tax (15%)",
      taxRatePercent: item.taxRatePercent !== undefined ? item.taxRatePercent : 15,
      isActive: item.isActive !== false,
      menuTiming: item.menuTiming || "All Day",
      categories: item.categories || [item.category],
      promoStickers: item.promoStickers || [],
      galleryImages: item.galleryImages || []
    };

    await db.collection("menu").doc(itemId).set(newItem);

    const snapshot = await db.collection("menu").get();
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, menu });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to save menu item", details: error.message });
  }
});

app.delete("/api/menu/:id", requireStaffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("menu").doc(id).delete();

    const snapshot = await db.collection("menu").get();
    const menu = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, menu });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to delete menu item", details: error.message });
  }
});

// 2. Order Endpoints
app.get("/api/orders", requireStaffAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("orders").orderBy("createdAt", "desc").get();
    const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(orders);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch orders", details: error.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const orderData = req.body;
    if (!orderData.items || orderData.items.length === 0) {
      return res.status(400).json({ error: "Order items cannot be empty." });
    }

    const orderId = orderData.id || `TX-${Math.floor(1000 + Math.random() * 9000)}`;
    const nowISO = new Date().toISOString();
    const status = orderData.status || "pending";
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

    // ---- P0 financial integrity: never trust client-supplied prices/totals. ----
    // Recompute each line using the authoritative menu doc; reject unknown items.
    const recomputedItems: any[] = [];
    let subtotal = 0;
    for (const line of (orderData.items || [])) {
      const raw = line?.menuItem ? line.menuItem : line;
      const quantity = Number(line?.quantity) > 0 ? Number(line.quantity) : 1;
      const menuItemId = raw?.id || raw?.menuItemId;
      if (!menuItemId) {
        return res.status(400).json({ error: "Each order item must reference a menu item id." });
      }
      const menuDoc = await db.collection("menu").doc(String(menuItemId)).get();
      if (!menuDoc.exists) {
        return res.status(400).json({ error: `Menu item '${menuItemId}' is no longer available and cannot be ordered.` });
      }
      const menuData = menuDoc.data();
      const unitPrice = Number(menuData.price) || 0;
      subtotal += unitPrice * quantity;
      recomputedItems.push({ menuItem: { ...menuData, id: menuData.id || String(menuItemId) }, quantity });
    }

    // Service tax and delivery fee come from the authoritative checkout settings.
    const taxPercent = Number(checkoutCfg.serviceTaxPercent) || 0;
    const deliveryFlatFee = Number(checkoutCfg.flatFeeETB) || 0;
    const serviceTax = Math.round(subtotal * taxPercent) / 100;
    const flatFee = fulfillmentType === 'delivery' ? deliveryFlatFee : 0;

    // Validate the promo against the authoritative promo doc before discounting.
    let discountAmount = 0;
    if (orderData.promoCode) {
      const promoCode = String(orderData.promoCode).trim().toUpperCase();
      const promoSnap = await db.collection("promoCodes").doc(promoCode).get();
      if (promoSnap.exists) {
        const promo = promoSnap.data();
        const promoActive = promo.active !== false;
        const promoExpired = promo.expiresAt && new Date(promo.expiresAt).getTime() < Date.now();
        const aboveMinOrder = !promo.minOrderAmount || subtotal >= Number(promo.minOrderAmount);
        if (promoActive && !promoExpired && aboveMinOrder) {
          if (promo.type === 'percentage') {
            discountAmount = subtotal * ((Number(promo.value) || 0) / 100);
            if (promo.maxDiscount) discountAmount = Math.min(discountAmount, Number(promo.maxDiscount));
          } else {
            discountAmount = Number(promo.value) || 0;
          }
          discountAmount = Math.max(0, discountAmount);
        }
      }
    }

    const total = Math.max(0, Math.round((subtotal + serviceTax + flatFee - discountAmount) * 100) / 100);
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
      transactionRef: orderData.transactionRef || orderId,
      createdAt: nowISO,
      updatedAt: nowISO,
      statusHistory: [{ status, at: nowISO }],
      paymentHistory: [{ paymentStatus, at: nowISO }],
      userId: orderData.userId || null,
      serviceTax: serviceTax,
      flatFee: flatFee,
      promoCode: orderData.promoCode ? String(orderData.promoCode).trim().toUpperCase() : null,
      discountAmount: discountAmount
    };

    await db.collection("orders").doc(orderId).set(newOrder);
    await applyPromo(newOrder, db);

    res.json({ success: true, order: newOrder });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to place order", details: error.message });
  }
});

app.patch("/api/orders/:id", requireStaffAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus, deliveryMinutes } = req.body;

    const nowISO = new Date().toISOString();
    const existingRef = db.collection("orders").doc(id);
    const existingSnap = await existingRef.get();
    const existingData = existingSnap.exists ? existingSnap.data() : {};

    const updates: any = {
      updatedAt: nowISO,
      statusHistory: Array.isArray(existingData.statusHistory) ? existingData.statusHistory : [],
      paymentHistory: Array.isArray(existingData.paymentHistory) ? existingData.paymentHistory : []
    };

    if (status && status !== existingData.status) {
      updates.status = status;
      updates.statusHistory.push({ status, at: nowISO });
    }
    if (paymentStatus && paymentStatus !== existingData.paymentStatus) {
      updates.paymentStatus = paymentStatus;
      updates.paymentHistory.push({ paymentStatus, at: nowISO });
    }
    if (deliveryMinutes) updates.deliveryMinutes = deliveryMinutes;

    if (Object.keys(updates).length > 0) {
      await existingRef.update(updates);

      // Trigger Shipday ONLY when status becomes 'ready' AND order is delivery fulfillment
      if (status === "ready" && existingData.fulfillmentType !== 'pickup' && existingData.fulfillmentType !== 'dineIn') {
        console.log(`[SHIPDAY] Status for ${id} changed to ready. Syncing...`);
        triggerShipday(id, db, deliveryMinutes);
      } else if (status === "ready") {
        console.log(`[SHIPDAY] Order ${id} is ${existingData.fulfillmentType || 'delivery'} fulfillment; holding at ready (no Shipday dispatch).`);
      }
    }

    const docSnap = await existingRef.get();
    res.json({ success: true, order: { id: docSnap.id, ...docSnap.data() } });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to update order", details: error.message });
  }
});

// Chapa Webhook Endpoint
app.post("/api/chapa/webhook", async (req: any, res) => {
  try {
    // ---- Fail closed: never process webhooks without a real shared secret configured. ----
    if (isMissingOrPlaceholderSecret(process.env.CHAPA_WEBHOOK_SECRET)) {
      console.warn("[CHAPA WEBHOOK] CHAPA_WEBHOOK_SECRET not configured; rejecting (fail closed).");
      return res.status(503).send("Webhook disabled: CHAPA_WEBHOOK_SECRET not configured.");
    }

    // ---- Verify webhook origin with HMAC SHA256 secret-hash signature ----
    const webhookSecret = (process.env.CHAPA_WEBHOOK_SECRET || "").trim();
    const signatureHeader = (req.headers["x-chapa-signature"] || req.headers["chapa-signature"] || "") as string;

    if (webhookSecret) {
      const rawBody = (req.rawBody || JSON.stringify(req.body || {})).toString();
      const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
      const supplied = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      const signatureMatches = supplied && typeof supplied === "string" && expected.length === supplied.length
        ? crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))
        : expected.toLowerCase() === String(supplied || "").toLowerCase();

      if (!signatureMatches) {
        console.warn(`[CHAPA WEBHOOK] Signature verification FAILED. Expected ${expected}, got ${signatureHeader}.`);
        return res.status(401).send("Invalid signature");
      }
      console.log(`[CHAPA WEBHOOK] Signature verified with secret hash.`);
    } else {
      console.warn(`[CHAPA WEBHOOK] No CHAPA_WEBHOOK_SECRET configured; skipping signature verification.`);
    }

    const event = req.body;
    const txRef = event.tx_ref || event.txRef;
    const eventName = String(event.event || "").toLowerCase();
    const eventStatus = String(event.status || "").toLowerCase();

    console.log(`[CHAPA WEBHOOK] Received event '${eventName}' (status: ${eventStatus}) for ${txRef}`);

    // Always ack 200 so Chapa stops retrying, even for unknown/duplicate events.
    if (!txRef) {
      return res.status(200).send("Webhook received");
    }

    const orderRef = db.collection("orders").doc(txRef);
    const docSnap = await orderRef.get();
    if (!docSnap.exists) {
      console.warn(`[CHAPA WEBHOOK] Order ${txRef} not found in Firestore`);
      return res.status(200).send("Webhook received");
    }
    const orderData = docSnap.data();

    // ---- SUCCESSFUL PAYMENT ----
    if (eventName === "charge.success" || eventStatus === "success") {
      // Idempotency: if already completed, ack without side effects.
      if (orderData.paymentStatus === "completed") {
        console.log(`[CHAPA WEBHOOK] Order ${txRef} already completed; skipping duplicate event.`);
        return res.status(200).send("Webhook received");
      }

      // Docs best practice: re-verify critical transaction data via the REST verify API
      // before granting value, to confirm status/amount/tx_ref/mode are consistent.
      const rawKey = (process.env.CHAPA_SECRET_KEY || "").trim();
      const chapaKey = (rawKey.startsWith("CHASECK_") || rawKey.startsWith("CHAPASECKEY-")) ? rawKey : "";
      let verified = false;
      let verifiedData: any = null;

      if (chapaKey && chapaKey !== "MY_CHAPA_SECRET_KEY" && !chapaKey.startsWith("CHAPASECKEY-xxxx")) {
        try {
          const vres = await fetch(`https://api.chapa.co/v1/transaction/verify/${txRef}`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${chapaKey}` }
          });
          const vdata = await vres.json();
          console.log(`[CHAPA WEBHOOK] Re-verification response (${vres.status}):`, JSON.stringify(vdata).slice(0, 400));
          if (vdata.status === "success" && vdata.data?.status === "success") {
            verified = true;
            verifiedData = vdata.data;
          } else {
            console.warn(`[CHAPA WEBHOOK] Webhook said success but verify API returned: ${vdata.data?.status}. Not granting value.`);
          }
        } catch (verr: any) {
          console.error("[CHAPA WEBHOOK] Verification API error:", verr.message);
        }
      } else {
        // Fail closed: never grant value without a real secret key to re-verify against Chapa.
        verified = false;
        console.warn(`[CHAPA WEBHOOK] No real CHAPA_SECRET_KEY configured; refusing to grant value (fail closed).`);
      }

      if (verified) {
        const raw = verifiedData || event;
        const receiptInfo = {
          transactionId: raw.reference || raw.ref_id || txRef,
          reference: raw.reference || raw.ref_id || txRef,
          amount: raw.amount ? parseFloat(raw.amount) : (orderData?.total || 0),
          currency: raw.currency || "ETB",
          paymentMethod: raw.payment_method || raw.method || "Chapa",
          fullName: `${raw.first_name || ""} ${raw.last_name || ""}`.trim() || (orderData?.customerName || ""),
          email: raw.email || (orderData?.customerEmail || ""),
          date: raw.created_at || new Date().toISOString(),
          status: "success",
          simulated: !verifiedData
        };

        await orderRef.update({
          paymentStatus: "completed",
          status: "pending",
          receipt: receiptInfo,
          updatedAt: new Date().toISOString(),
          statusHistory: Array.isArray(orderData.statusHistory) ? [...orderData.statusHistory, { status: "pending", at: new Date().toISOString() }] : undefined,
          paymentHistory: Array.isArray(orderData.paymentHistory) ? [...orderData.paymentHistory, { paymentStatus: "completed", at: new Date().toISOString() }] : undefined
        });

        console.log(`[CHAPA WEBHOOK] Order ${txRef} marked completed (via ${verifiedData ? "re-verified API" : "signed webhook"}).`);
        await applyPromo(orderData, db);
      }
    }
    // ---- FAILED / CANCELLED ----
    else if (eventName === "charge.failed/cancelled" || eventName.startsWith("charge.failed") || eventName.startsWith("charge.cancelled") || eventStatus === "failed/cancelled" || eventStatus === "failed" || eventStatus === "cancelled") {
      if (orderData.paymentStatus !== "failed") {
        await orderRef.update({
          paymentStatus: "failed",
          updatedAt: new Date().toISOString(),
          paymentHistory: Array.isArray(orderData.paymentHistory) ? [...orderData.paymentHistory, { paymentStatus: "failed", at: new Date().toISOString() }] : undefined
        });
        console.log(`[CHAPA WEBHOOK] Order ${txRef} marked failed (reason: ${event.failure_reason || "N/A"}).`);
      } else {
        console.log(`[CHAPA WEBHOOK] Order ${txRef} already failed; skipping duplicate event.`);
      }
    }
    // ---- REVERSED ----
    else if (eventName === "charge.reversed" || eventStatus === "reversed") {
      if (orderData.paymentStatus !== "reversed") {
        await orderRef.update({
          paymentStatus: "reversed",
          status: "cancelled",
          updatedAt: new Date().toISOString(),
          statusHistory: Array.isArray(orderData.statusHistory) ? [...orderData.statusHistory, { status: "cancelled", at: new Date().toISOString() }] : undefined,
          paymentHistory: Array.isArray(orderData.paymentHistory) ? [...orderData.paymentHistory, { paymentStatus: "reversed", at: new Date().toISOString() }] : undefined
        });
        console.log(`[CHAPA WEBHOOK] Order ${txRef} marked reversed.`);
      } else {
        console.log(`[CHAPA WEBHOOK] Order ${txRef} already reversed; skipping duplicate event.`);
      }
    }
    // ---- REFUNDED (feature removed; log only) ----
    else if (eventName === "charge.refunded" || eventStatus === "refunded") {
      console.log(`[CHAPA WEBHOOK] Refund event for order ${txRef} ignored (refund feature removed).`);
    }
    else {
      console.warn(`[CHAPA WEBHOOK] Unhandled event '${eventName}' (status: ${eventStatus}) for order ${txRef}.`);
    }

    res.status(200).send("Webhook received");
  } catch (error: any) {
    console.error("Webhook processing error:", error.message);
    res.status(500).send("Server Error");
  }
});

// Chapa Callback URL (docs: receives a GET with {trx_ref, ref_id, status} after payment)
app.get("/api/chapa/callback", async (req, res) => {
  try {
    // ---- Fail closed: do not trust callbacks when no real webhook secret is configured. ----
    if (isMissingOrPlaceholderSecret(process.env.CHAPA_WEBHOOK_SECRET)) {
      console.warn("[CHAPA CALLBACK] CHAPA_WEBHOOK_SECRET not configured; refusing callback (fail closed).");
      return res.status(503).json({ error: "Callback disabled: CHAPA_WEBHOOK_SECRET not configured." });
    }

    const txRef = req.query.trx_ref || req.query.tx_ref || req.query["tx_ref"];
    const refId = req.query.ref_id;
    const status = String(req.query.status || "").toLowerCase();

    console.log(`[CHAPA CALLBACK] Received callback for txRef: ${txRef}, refId: ${refId}, status: ${status}`);

    if (!txRef) {
      return res.status(400).json({ error: "Missing transaction reference" });
    }

    // Forward to the verification flow so status is re-checked against Chapa's API.
    const orderRef = db.collection("orders").doc(String(txRef));
    const docSnap = await orderRef.get();
    if (!docSnap.exists) {
      console.warn(`[CHAPA CALLBACK] Order ${txRef} not found`);
      return res.status(404).json({ error: "Transaction reference not found" });
    }

    if (status === "success") {
      const rawKey = (process.env.CHAPA_SECRET_KEY || "").trim();
      const chapaKey = (rawKey.startsWith("CHASECK_") || rawKey.startsWith("CHAPASECKEY-")) ? rawKey : "";
      const orderData = docSnap.data();

      if (orderData.paymentStatus === "completed") {
        console.log(`[CHAPA CALLBACK] Order ${txRef} already completed; skipping.`);
        return res.redirect(`/?status=success&tx_ref=${txRef}`);
      }

      if (chapaKey && chapaKey !== "MY_CHAPA_SECRET_KEY" && !chapaKey.startsWith("CHAPASECKEY-xxxx")) {
        const response = await fetch(`https://api.chapa.co/v1/transaction/verify/${txRef}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${chapaKey}` }
        });
        const chapaData = await response.json();

        if (chapaData.status === "success" && chapaData.data?.status === "success") {
          const rawData = chapaData.data;
          const receiptInfo = {
            transactionId: rawData.reference || String(txRef),
            reference: rawData.reference || String(txRef),
            amount: rawData.amount ? parseFloat(rawData.amount) : (orderData?.total || 0),
            currency: rawData.currency || "ETB",
            paymentMethod: rawData.payment_method || rawData.method || "Chapa",
            fullName: `${rawData.first_name || ""} ${rawData.last_name || ""}`.trim() || (orderData?.customerName || ""),
            email: rawData.email || (orderData?.customerEmail || ""),
            date: rawData.created_at || new Date().toISOString(),
            status: "success",
            simulated: false
          };
          await orderRef.update({
            paymentStatus: "completed",
            status: "pending",
            receipt: receiptInfo,
            updatedAt: new Date().toISOString(),
            statusHistory: Array.isArray(orderData.statusHistory) ? [...orderData.statusHistory, { status: "pending", at: new Date().toISOString() }] : undefined,
            paymentHistory: Array.isArray(orderData.paymentHistory) ? [...orderData.paymentHistory, { paymentStatus: "completed", at: new Date().toISOString() }] : undefined
          });
          if (orderData.paymentStatus !== "completed") { await applyPromo(orderData, db); }
          console.log(`[CHAPA CALLBACK] Order ${txRef} completed via callback verification.`);
        } else {
          console.warn(`[CHAPA CALLBACK] Verification returned non-success (${chapaData.data?.status}).`);
        }
      } else {
        console.warn(`[CHAPA CALLBACK] No real CHAPA_SECRET_KEY configured; refusing to complete order ${txRef} (fail closed).`);
        return res.redirect(`/?status=pending&tx_ref=${txRef}&error=verification_disabled`);
      }
    } else {
      console.warn(`[CHAPA CALLBACK] Non-success callback status: ${status}`);
    }

    return res.redirect(`/?status=${status || "pending"}&tx_ref=${txRef}`);
  } catch (error: any) {
    console.error("Chapa callback error:", error.message);
    res.status(500).json({ error: "Callback processing failed" });
  }
});

// Chapa Initialize
app.post("/api/chapa/initialize", async (req, res) => {
  try {
    dotenv.config({ override: true });
    const { amount, email, first_name, last_name, phone_number, items } = req.body;

    if (!amount || !email || !first_name || !last_name) {
      return res.status(400).json({ error: "Missing required Chapa initiation parameters." });
    }

    const tx_ref = `tx-savory-${Date.now()}`;
    const rawKey = (process.env.CHAPA_SECRET_KEY || "").trim();
    const rawPublicKey = (process.env.VITE_CHAPA_PUBLIC_KEY || process.env.CHAPA_PUBLIC_KEY || "").trim();

    const secretKey = (rawKey.startsWith("CHASECK_") || rawKey.startsWith("CHAPASECKEY-")) ? rawKey : "";
    const publicKey = rawPublicKey || (rawKey.startsWith("CHAPUBK_") ? rawKey : "");

    // Dynamically detect the base URL of the request
    const requestHost = req.headers.host || "localhost:3000";
    const requestProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || "http";
    const requestOrigin = `${requestProto}://${requestHost}`;
    let rawBase = (process.env.APP_URL || requestOrigin).trim().replace(/\/+$/, "");
    if (!rawBase.startsWith("http://") && !rawBase.startsWith("https://")) {
      rawBase = `https://${rawBase}`;
    }
    const baseUrl = rawBase;

    console.log(`[CHAPA INITIALIZE] Base URL resolved to: ${baseUrl} (Host: ${requestHost}, Proto: ${requestProto})`);

    const newOrder = {
      id: tx_ref,
      items: items || [],
      status: "pending",
      total: parseFloat(amount),
      customerName: `${first_name} ${last_name}`,
      customerEmail: email,
      customerPhone: phone_number || "",
      blockNumber: req.body.blockNumber || "",
      roomNumber: req.body.roomNumber || "",
      googleMapsAddress: req.body.googleMapsAddress || "",
      specialInstructions: req.body.specialInstructions || "",
      paymentMethod: "chapa",
      paymentStatus: "pending",
      fulfillmentType: ['delivery', 'pickup', 'dineIn'].includes(req.body.fulfillmentType) ? req.body.fulfillmentType : 'delivery',
      scheduledFor: await (async () => {
        const cfg = await getCheckoutSettings(db);
        return normalizeScheduledFor(req.body.scheduledFor, cfg.prepTimeMinutes || 30);
      })(),
      transactionRef: tx_ref,
      createdAt: new Date().toISOString(),
      userId: req.body.userId || null,
      serviceTax: req.body.serviceTax || 0,
      flatFee: req.body.flatFee || 0,
      promoCode: req.body.promoCode || null,
      discountAmount: req.body.discountAmount || 0
    };

    await db.collection("orders").doc(tx_ref).set(newOrder);

    // 1. If Secret Key is available, initialize via Chapa's official REST API (Hosted Checkout)
    if (secretKey && secretKey !== "MY_CHAPA_SECRET_KEY") {
      console.log(`[CHAPA] Attempting server-to-server hosted payment initiation for reference ${tx_ref}`);
      try {
        const chapaPayload: any = {
          amount: amount.toString(),
          currency: "ETB",
          email: email.trim(),
          first_name: first_name.trim(),
          last_name: last_name.trim(),
          tx_ref: tx_ref,
          callback_url: `${baseUrl}/api/chapa/callback`,
          return_url: `${baseUrl}/?status=success&tx_ref=${tx_ref}`,
          customization: {
            title: "Savory Order",
            description: `Payment for ${items?.length || 1} items`
          }
        };
        if (phone_number && phone_number.trim().length > 0) {
          chapaPayload.phone_number = phone_number.trim();
        }

        const response = await fetch("https://api.chapa.co/v1/transaction/initialize", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${secretKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(chapaPayload)
        });

        const rawText = await response.text();
        let chapaData: any = {};
        try {
          chapaData = JSON.parse(rawText);
        } catch (e) {
          console.error("[CHAPA INITIALIZE] Invalid JSON from Chapa API:", rawText);
          return res.status(502).json({ success: false, error: "Chapa API returned non-JSON response", raw: rawText.slice(0, 200) });
        }

        console.log(`[CHAPA INITIALIZE] Response status: ${response.status}`, chapaData);

        if (chapaData.status === "success" && chapaData.data?.checkout_url) {
          await db.collection("orders").doc(tx_ref).update({ chapaCheckoutUrl: chapaData.data.checkout_url });
          return res.json({ success: true, mode: "hosted", checkoutUrl: chapaData.data.checkout_url, txRef: tx_ref });
        } else {
          let errorMsg = "Chapa API initialization failed";
          if (typeof chapaData.message === "string") {
            errorMsg = chapaData.message;
          } else if (typeof chapaData.message === "object" && chapaData.message !== null) {
            errorMsg = Object.entries(chapaData.message)
              .map(([field, errs]) => `${field}: ${Array.isArray(errs) ? errs.join(", ") : errs}`)
              .join(" | ");
          } else if (typeof chapaData.error === "string") {
            errorMsg = chapaData.error;
          } else if (typeof chapaData.errors === "object" && chapaData.errors !== null) {
            errorMsg = Object.entries(chapaData.errors)
              .map(([field, errs]) => `${field}: ${Array.isArray(errs) ? errs.join(", ") : errs}`)
              .join(" | ");
          }
          return res.status(400).json({ success: false, error: errorMsg, details: chapaData });
        }
      } catch (err: any) {
        console.error("[CHAPA INITIALIZE] Fetch error:", err);
        return res.status(500).json({ success: false, error: "Chapa connection failed: " + err.message });
      }
    }

    // 2. If Public Key is available, initialize via Chapa Inline Popup
    if (publicKey) {
      console.log(`[CHAPA] Returning inline public key checkout mode for reference ${tx_ref}`);
      return res.json({
        success: true,
        mode: "inline",
        publicKey: publicKey,
        txRef: tx_ref,
        callbackUrl: `${baseUrl}/api/chapa/callback`,
        returnUrl: `${baseUrl}/?status=success&tx_ref=${tx_ref}`
      });
    }

    return res.status(400).json({
      success: false,
      error: "Missing CHAPA credentials in .env. Please provide either CHAPA_SECRET_KEY (starts with CHASECK_) or public key (starts with CHAPUBK_)."
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to initialize payment", details: error.message });
  }
});

// Callback verification from Chapa
app.get("/api/chapa/verify/:txRef", async (req, res) => {
  console.log(`[CHAPA VERIFY] Verification request received for txRef: ${req.params.txRef}`);
  try {
    dotenv.config({ override: true });
    const { txRef } = req.params;
    const rawKey = (process.env.CHAPA_SECRET_KEY || "").trim();
    const chapaKey = (rawKey.startsWith("CHASECK_") || rawKey.startsWith("CHAPASECKEY-")) ? rawKey : "";

    const orderRef = db.collection("orders").doc(txRef);
    const docSnap = await orderRef.get();

    if (!docSnap.exists) {
      console.warn(`[CHAPA VERIFY] Order with txRef: ${txRef} not found in Firestore`);
      return res.status(404).json({ error: "Order or transaction reference not found" });
    }

    console.log(`[CHAPA VERIFY] Order found. Current payment status: ${docSnap.data()?.paymentStatus}`);

    if (chapaKey && chapaKey !== "MY_CHAPA_SECRET_KEY" && !chapaKey.startsWith("CHAPASECKEY-xxxx")) {
      console.log(`[CHAPA VERIFY] Real Chapa Secret Key detected. Fetching verification from Chapa API...`);
      try {
        const response = await fetch(`https://api.chapa.co/v1/transaction/verify/${txRef}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${chapaKey}` }
        });

        console.log(`[CHAPA VERIFY] Chapa API status code: ${response.status}`);
        const chapaData = await response.json();
        console.log(`[CHAPA VERIFY] Chapa API response body:`, JSON.stringify(chapaData));

        if (chapaData.status === "success" && chapaData.data?.status === "success") {
          console.log(`[CHAPA VERIFY] Payment verified successfully! Updating Firestore to completed.`);
          const rawData = chapaData.data;
          const orderData = docSnap.data();
          const receiptInfo = {
            transactionId: rawData.reference || txRef,
            reference: rawData.reference || txRef,
            amount: rawData.amount ? parseFloat(rawData.amount) : (orderData?.total || 0),
            currency: rawData.currency || "ETB",
            paymentMethod: rawData.payment_method || rawData.method || "Chapa",
            fullName: `${rawData.first_name || ""} ${rawData.last_name || ""}`.trim() || (orderData?.customerName || ""),
            email: rawData.email || (orderData?.customerEmail || ""),
            date: rawData.created_at || new Date().toISOString(),
            status: "success",
            simulated: false
          };

          await orderRef.update({
            paymentStatus: "completed",
            status: "pending",
            receipt: receiptInfo
          });
          if (orderData.paymentStatus !== "completed") { await applyPromo(orderData, db); }
          if (!orderData.paymentHistory || !Array.isArray(orderData.paymentHistory)) {
            await orderRef.update({ paymentHistory: [{ paymentStatus: "completed", at: new Date().toISOString() }] });
          }

          const updatedDoc = await orderRef.get();
          return res.json({ success: true, status: "completed", order: { id: updatedDoc.id, ...updatedDoc.data() } });
        } else {
          console.warn(`[CHAPA VERIFY] Chapa API verification returned non-success structure or status. Data status: ${chapaData.data?.status}`);
          return res.status(400).json({ success: false, status: "pending", error: "Payment not completed yet" });
        }
      } catch (err: any) {
        console.error("[CHAPA VERIFY] Verification network/JSON error:", err.message);
        return res.status(500).json({ success: false, error: "Network error during verification" });
      }
    } else {
      console.warn(`[CHAPA VERIFY] No real Chapa Secret Key configured; refusing to grant value (fail closed).`);
      return res.status(503).json({
        success: false,
        status: docSnap.data()?.paymentStatus || "pending",
        error: "Chapa secret key not configured. Verification disabled (fail closed)."
      });
    }
  } catch (error: any) {
    console.error(`[CHAPA VERIFY] Fatal error during verification:`, error.message);
    res.status(500).json({ error: "Verification failed", details: error.message });
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
      res.json({ serviceTaxPercent: 15, flatFeeETB: 0, shipdayDeliveryMinutes: 20, isOpen: true, scheduleEnabled: false, openTime: "09:00", closeTime: "22:00", prepTimeMinutes: 30, scheduledStepsMinutes: 15 });
    }
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch checkout settings", details: error.message });
  }
});

app.post("/api/settings", requireStaffAuth, async (req, res) => {
  try {
    const { serviceTaxPercent, flatFeeETB, shipdayDeliveryMinutes, isOpen } = req.body;
    const settings = {
      serviceTaxPercent: parseFloat(serviceTaxPercent) || 0,
      flatFeeETB: parseFloat(flatFeeETB) || 0,
      shipdayDeliveryMinutes: parseInt(shipdayDeliveryMinutes) || 20,
      shipdayPickupMinutes: parseInt(req.body.shipdayPickupMinutes) || 10,
      enableCOD: req.body.enableCOD !== undefined ? req.body.enableCOD : true,
      isOpen: isOpen !== undefined ? isOpen : true,
      scheduleEnabled: req.body.scheduleEnabled !== undefined ? !!req.body.scheduleEnabled : false,
      openTime: req.body.openTime || "09:00",
      closeTime: req.body.closeTime || "22:00",
      prepTimeMinutes: parseInt(req.body.prepTimeMinutes) || 30,
      scheduledStepsMinutes: parseInt(req.body.scheduledStepsMinutes) || 15,
      updatedAt: new Date().toISOString()
    };
    await db.collection("settings").doc("checkout").set(settings);
    res.json({ success: true, settings });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to save checkout settings", details: error.message });
  }
});

// Customer Management Endpoints
app.get("/api/customers", requireStaffAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("users").get();
    const customers = snapshot.docs.map(doc => ({ uid: doc.id, id: doc.id, ...doc.data() }));
    res.json(customers);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch customers", details: error.message });
  }
});

app.patch("/api/customers/:uid/points", requireStaffAuth, async (req, res) => {
  try {
    const { uid } = req.params;
    const { delta } = req.body;

    if (typeof delta !== "number" || isNaN(delta)) {
      return res.status(400).json({ error: "A numeric 'delta' is required to adjust loyalty points." });
    }

    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Customer account not found." });
    }

    const current = Number(snap.data()?.points) || 0;
    const adjusted = Math.max(0, current + delta);

    await userRef.set({ points: adjusted }, { merge: true });

    res.json({ success: true, points: adjusted, delta });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to adjust loyalty points", details: error.message });
  }
});

// Mailchimp Connection Test Endpoint
app.get("/api/mailchimp/test", requireStaffAuth, async (req, res) => {
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
    const mailchimpUrl = `https://${datacenter}.api.mailchimp.com/3.0/lists/${listId}`;

    const response = await fetch(mailchimpUrl, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();

    if (response.ok) {
      res.json({ success: true, message: `Connected to Mailchimp! List: ${data.name}` });
    } else {
      res.status(400).json({ success: false, error: data.title || "Mailchimp connection failed" });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: "Test failed: " + error.message });
  }
});

// 4. Shipday API Integration
app.post("/api/shipday/order", requireStaffAuth, async (req, res) => {
  try {
    const settingsSnap = await db.collection("settings").doc("checkout").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};

    const shipdayKey = process.env.SHIPDAY_API_KEY || settings.shipdayApiKey;
    if (!shipdayKey) {
      return res.status(500).json({
        error: "Shipday API is not configured.",
        details: "Please add your SHIPDAY_API_KEY to the environment secrets."
      });
    }

    const { orderData } = req.body;
    if (!orderData) {
      return res.status(400).json({ error: "Order data is required." });
    }

    console.log(`[SHIPDAY] Sending order ${orderData.id} to Shipday using axios...`);

    const shipdayResponse = await axios.post(
      "https://api.shipday.com/orders",
      {
        orderNumber: String(orderData.id),
        customerName: orderData.customerName,
        customerAddress: orderData.googleMapsAddress || "No address provided",
        customerEmail: orderData.customerEmail || "",
        customerPhoneNumber: orderData.customerPhone,
        restaurantName: "Savory VPS",
        restaurantAddress: "Addis Ababa, Ethiopia",
        orderItems: (orderData.items || []).map((item: { name: string; price: number; quantity?: number }) => ({
          name: item.name,
          unitPrice: item.price,
          quantity: item.quantity || 1
        })),
        totalOrderCost: orderData.total,
        deliveryFee: orderData.flatFee || 0,
        tax: orderData.serviceTax || 0
      },
      {
        headers: {
          "Authorization": "Basic " + shipdayKey,
          "Content-Type": "application/json"
        }
      }
    );

    const data = shipdayResponse.data;
    console.log(`[SHIPDAY] Order ${orderData.id} successfully created in Shipday.`);

    // Update order in Firestore with Shipday info
    if (data.orderId) {
      await db.collection("orders").doc(orderData.id).set({
        shipdayOrderId: data.orderId,
        shipdayStatus: "created",
        shipdayTrackingLink: data.trackingLink || data.shortTrackingLink || null,
        shipdayLastUpdate: new Date().toISOString()
      }, { merge: true });
    }

    res.json({ success: true, shipdayData: data });
  } catch (error: any) {
    console.error("[SHIPDAY] API Error Details:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: "Failed to connect to Shipday",
      details: error.response?.data || error.message
    });
  }
});

app.get("/api/shipday/test", requireStaffAuth, async (req, res) => {
  try {
    const settingsSnap = await db.collection("settings").doc("checkout").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};

    const shipdayKey = process.env.SHIPDAY_API_KEY || settings.shipdayApiKey;

    if (!shipdayKey || shipdayKey === "") {
      return res.status(400).json({
        success: false,
        error: "Shipday API key not found in environment secrets.",
        hint: "Please ensure SHIPDAY_API_KEY is configured in the environment."
      });
    }

    console.log(`[SHIPDAY TEST] Testing connectivity to Shipday...`);
    const shipdayResponse = await axios.get("https://api.shipday.com/orders", {
      headers: {
        "Authorization": "Basic " + shipdayKey
      }
    });

    const orders = shipdayResponse.data;
    const orderCount = Array.isArray(orders) ? orders.length : 0;

    res.json({
      success: true,
      message: "Successfully connected to Shipday API",
      orderCount: orderCount
    });
  } catch (error: any) {
    console.error("[SHIPDAY TEST] Error details:", error.response?.data || error.message);

    let errorMessage = "Connection failed. Check your API key.";
    if (error.response?.status === 401) {
      errorMessage = "Invalid API Key (Unauthorized).";
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = "Could not reach Shipday API (Network Error).";
    }

    res.status(400).json({
      success: false,
      error: errorMessage,
      details: error.response?.data || error.message
    });
  }
});

// Shipday Webhook Receiver
app.post("/api/shipday/webhook", async (req, res) => {
  try {
    // ---- Fail closed: the webhook must never run without a real shared token configured. ----
    if (isMissingOrPlaceholderSecret(process.env.SHIPDAY_WEBHOOK_TOKEN)) {
      console.warn("[SHIPDAY WEBHOOK] SHIPDAY_WEBHOOK_TOKEN not configured; rejecting (fail closed).");
      return res.status(503).json({ error: "Webhook disabled: SHIPDAY_WEBHOOK_TOKEN not configured." });
    }

    const token = req.query.token || req.headers['x-shipday-token'];
    const expectedToken = String(process.env.SHIPDAY_WEBHOOK_TOKEN).trim();

    // Verify the shared token mandatorily (it was previously optional when unset).
    if (!token || token !== expectedToken) {
      console.warn("[SHIPDAY WEBHOOK] Unauthorized access attempt with invalid/missing token.");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body;
    console.log("[SHIPDAY WEBHOOK] Received payload:", JSON.stringify(payload, null, 2));

    // Helper to extract values from nested or top-level objects in the webhook payload
    const extractValue = (obj: any, keys: string[]): any => {
      if (!obj || typeof obj !== 'object') return undefined;
      for (const key of keys) {
        if (obj[key] !== undefined) return obj[key];
      }
      // Check common nested structures like obj.order, obj.data, etc.
      const nestedContainers = ['order', 'data', 'eventData', 'payload'];
      for (const container of nestedContainers) {
        if (obj[container] && typeof obj[container] === 'object') {
          const val = extractValue(obj[container], keys);
          if (val !== undefined) return val;
        }
      }
      return undefined;
    };

    // Extract orderNumber/orderId and status robustly
    const orderIdRaw = extractValue(payload, ['orderNumber', 'order_number', 'orderId', 'order_id', 'id']);
    const shipdayStatusRaw = extractValue(payload, ['status', 'orderStatus', 'order_status', 'state', 'event', 'deliveryStatus', 'delivery_status']);

    if (orderIdRaw && shipdayStatusRaw) {
      const orderId = String(orderIdRaw).trim();
      const shipdayStatus = String(shipdayStatusRaw).trim();

      console.log(`[SHIPDAY WEBHOOK] Found order ${orderId} and status: ${shipdayStatus}`);
      const orderRef = db.collection("orders").doc(orderId);

      const updateData: any = {
        shipdayStatus: shipdayStatus,
        shipdayLastUpdate: new Date().toISOString()
      };

      // Clean up the status string to make comparisons more forgiving
      const normalizedStatus = shipdayStatus
        .toUpperCase()
        .replace(/[.\-\s]+/g, '_')
        .trim();

      console.log(`[SHIPDAY WEBHOOK] Normalized status for order ${orderId}: ${normalizedStatus}`);

      const completionStatuses = [
        "COMPLETED",
        "DELIVERED",
        "COMPLETE",
        "DONE",
        "FINISHED",
        "DELIVERY_COMPLETED",
        "ORDER_COMPLETED",
        "SUCCESS",
        "SUCCESSFUL",
        "ALREADY_DELIVERED"
      ];
      const cancellationStatuses = [
        "CANCELLED",
        "CANCELED",
        "DELETED",
        "REJECTED",
        "FAILED",
        "NOT_DELIVERED",
        "DELIVERY_FAILED",
        "ORDER_CANCELLED"
      ];
      const activeStatuses = [
        "ASSIGNED",
        "STARTED",
        "PICKED_UP",
        "ARRIVED",
        "ACTIVE",
        "DISPATCHED",
        "ON_THE_WAY",
        "IN_TRANSIT",
        "OUT_FOR_DELIVERY",
        "PICKUP"
      ];

      if (completionStatuses.includes(normalizedStatus)) {
        updateData.status = "delivered";
        console.log(`[SHIPDAY WEBHOOK] Mapping ${normalizedStatus} to delivered for ${orderId}`);
      } else if (cancellationStatuses.includes(normalizedStatus)) {
        updateData.status = "cancelled";
        console.log(`[SHIPDAY WEBHOOK] Mapping ${normalizedStatus} to cancelled for ${orderId}`);
      } else if (activeStatuses.includes(normalizedStatus)) {
        // Only update to preparing if it's currently pending
        // We want to avoid downgrading 'ready' or 'delivered'
        try {
          const currentSnap = await orderRef.get();
          if (currentSnap.exists) {
            const currentStatus = currentSnap.data().status;
            if (currentStatus === "pending") {
              updateData.status = "preparing";
              console.log(`[SHIPDAY WEBHOOK] Mapping ${normalizedStatus} to preparing for ${orderId} (current: ${currentStatus})`);
            } else {
              console.log(`[SHIPDAY WEBHOOK] Skipping status update for ${orderId}. Current status is ${currentStatus}, webhook status is ${normalizedStatus}`);
            }
          }
        } catch (e) {
          console.error("[SHIPDAY WEBHOOK] Error checking current status:", e);
        }
      }

      await orderRef.set(updateData, { merge: true });
      console.log(`[SHIPDAY WEBHOOK] Order ${orderId} successfully updated in Firestore with status: ${normalizedStatus}`);
    } else {
      console.warn(`[SHIPDAY WEBHOOK] Webhook received but orderIdRaw (${orderIdRaw}) or shipdayStatusRaw (${shipdayStatusRaw}) is missing.`, payload);
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[SHIPDAY WEBHOOK] Error processing webhook:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Vite or Static Files Handler
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("[VITE] Mounted dev middleware successfully");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] Ready! on http://localhost:${PORT}`);
  });
}

startServer();
