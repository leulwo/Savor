import crypto from "node:crypto";
import type { Express, RequestHandler } from "express";
import { orderCanBeFulfilled } from "./order-security";

type Options = {
  getApiKey: () => string;
  getWebhookToken: () => string;
  fetcher?: typeof fetch;
};

function failure(message: string, statusCode = 409, code = "SHIPDAY_REQUEST_REJECTED") {
  return Object.assign(new Error(message), { statusCode, code });
}
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
}
function providerId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) ? value : null;
}
function configured(value: string): boolean {
  return !!value && value.length <= 1024 && !/placeholder|replace[_-]?me|change[_-]?me|your[_-]|^x+$/i.test(value);
}
function text(value: unknown, max: number, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}
function safeTrackingUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !/^(?:[a-z0-9-]+\.)*shipday\.com$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
export function validShipdayWebhookToken(supplied: unknown, expected: string): boolean {
  if (!configured(expected) || typeof supplied !== "string" || supplied.length > 1024) return false;
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(supplied).digest(), crypto.createHash("sha256").update(expected).digest());
}

async function providerJson(response: Response): Promise<Record<string, any>> {
  if (!response.body) throw failure("Shipday returned an unreadable response.", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 128 * 1024) { await reader.cancel().catch(() => {}); throw new Error("response_limit"); }
      chunks.push(part.value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("response_shape");
    return result;
  } catch { throw failure("Shipday returned an unreadable response.", 502); }
  finally { reader.releaseLock(); }
}

export function createShipdayService(db: any, options: Options) {
  const fetcher = options.fetcher || fetch;

  async function create(orderId: string, deliveryMinutes?: number) {
    if (!validId(orderId)) throw failure("Invalid order reference.", 400);
    if (deliveryMinutes !== undefined && (!Number.isInteger(deliveryMinutes) || deliveryMinutes < 1 || deliveryMinutes > 240)) throw failure("Delivery time must be between 1 and 240 minutes.", 400);
    const apiKey = options.getApiKey().trim();
    if (!configured(apiKey)) throw failure("Shipday API is not configured.", 503, "SHIPDAY_NOT_CONFIGURED");
    const ref = db.collection("orders").doc(orderId);
    const dispatchToken = crypto.randomUUID();
    let claim: any;
    await db.runTransaction(async (transaction: any) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw failure("Stored order not found.", 404);
      const order = snapshot.data() || {};
      if (order.shipdayOrderId) {
        claim = { existing: { success: true, reused: true, shipdayOrderId: String(order.shipdayOrderId), trackingLink: safeTrackingUrl(order.shipdayTrackingLink) } };
        return;
      }
      if (!orderCanBeFulfilled(order)) throw failure("Online payment must be verified before sending this order to Shipday.");
      if (order.fulfillmentType && order.fulfillmentType !== "delivery") throw failure("Only delivery orders can be sent to Shipday.");
      if (!["ready", "dispatched"].includes(order.status)) throw failure("The order must be ready before sending it to Shipday.");
      if (["sending", "reconciling"].includes(order.shipdayDispatchState)) throw failure("This delivery request is already being checked. Confirm it in Shipday before retrying.", 409, "SHIPDAY_RECONCILING");
      const settingsSnapshot = await transaction.get(db.collection("settings").doc("checkout"));
      const settings = settingsSnapshot.exists ? settingsSnapshot.data() : {};
      transaction.update(ref, { shipdayDispatchState: "sending", shipdayDispatchToken: dispatchToken, shipdayDispatchStartedAt: new Date().toISOString(), shipdayDispatchError: "" });
      claim = { order, settings };
    });
    if (claim.existing) return claim.existing;
    const { order, settings } = claim;
    let contacted = false;
    let definitiveRejection = false;
    try {
      const items = Array.isArray(order.items) ? order.items : [];
      if (!items.length || items.length > 50) throw failure("Stored order items are invalid.", 409);
      const phone = text(order.customerPhone, 80);
      const customerPhoneNumber = /^0[79]\d{8}$/.test(phone) ? "+251" + phone.slice(1) : phone;
      if (!/^\+?[1-9]\d{8,14}$/.test(customerPhoneNumber)) throw failure("A valid customer phone number is required before dispatch.", 400);
      const now = Date.now();
      const pickupMinutes = Math.min(240, Math.max(1, Number(settings.shipdayPickupMinutes) || 10));
      const deliveryTime = deliveryMinutes || Math.min(240, Math.max(1, Number(settings.shipdayDeliveryMinutes) || 20));
      const scheduled = typeof order.scheduledFor === "string" ? Date.parse(order.scheduledFor) : NaN;
      const pickup = new Date(Number.isFinite(scheduled) && scheduled > now ? scheduled : now + pickupMinutes * 60000);
      const delivery = new Date(pickup.getTime() + deliveryTime * 60000);
      const payload = {
        orderNumber: orderId,
        customerName: text(order.customerName, 120),
        customerAddress: text(order.googleMapsAddress || order.blockNumber, 1000),
        customerEmail: text(order.customerEmail, 254), customerPhoneNumber,
        restaurantName: text(settings.restaurantName, 120, "Restaurant") || "Restaurant",
        restaurantAddress: text(settings.businessAddress, 1000, "Addis Ababa, Ethiopia") || "Addis Ababa, Ethiopia",
        ...(settings.businessPhone ? { restaurantPhoneNumber: text(settings.businessPhone, 80) } : {}),
        expectedDeliveryDate: delivery.toISOString().slice(0, 10),
        expectedPickupTime: pickup.toISOString().slice(11, 19), expectedDeliveryTime: delivery.toISOString().slice(11, 19),
        orderItem: items.map((line: any) => ({ name: text(line.menuItem?.name || line.name, 200, "Menu Item"), unitPrice: Number(line.menuItem?.price ?? line.price), quantity: Number(line.quantity) })),
        totalOrderCost: Number(order.total), deliveryFee: Number(order.flatFee) || 0,
        tax: Number(order.serviceTax) || 0, discountAmount: Number(order.discountAmount) || 0,
        deliveryInstruction: text(order.specialInstructions, 2000),
        paymentMethod: order.paymentMethod === "cash" ? "cash" : "credit_card"
      };
      if (!payload.customerName || !payload.customerAddress || !Number.isFinite(payload.totalOrderCost) || payload.totalOrderCost <= 0 || payload.orderItem.some((line: any) => !Number.isFinite(line.unitPrice) || line.unitPrice < 0 || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99)) throw failure("Complete the stored delivery details before dispatch.", 400);
      contacted = true;
      const response = await fetcher("https://api.shipday.com/orders", {
        method: "POST", redirect: "error",
        headers: { Authorization: "Basic " + apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        definitiveRejection = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status);
        throw failure(response.status === 401 || response.status === 403 ? "Shipday rejected the configured API key." : "Shipday could not accept the delivery request.", 502);
      }
      const result = await providerJson(response);
      const shipdayOrderId = providerId(result.orderId);
      if (result.success !== true || !shipdayOrderId) throw failure("Shipday did not confirm the delivery request. Confirm it in Shipday before retrying.", 502);
      const trackingLink = safeTrackingUrl(result.trackingLink || result.shortTrackingLink);
      await db.runTransaction(async (transaction: any) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists || snapshot.data()?.shipdayDispatchToken !== dispatchToken) throw failure("The delivery request changed while Shipday responded.");
        transaction.update(ref, { shipdayOrderId, shipdayStatus: "created", shipdayTrackingLink: trackingLink, shipdayDispatchState: "created", shipdayDispatchError: "", shipdaySyncedAt: new Date().toISOString(), shipdayLastUpdate: new Date().toISOString() });
      });
      return { success: true, reused: false, shipdayOrderId, trackingLink };
    } catch (error: any) {
      await db.runTransaction(async (transaction: any) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists || snapshot.data()?.shipdayDispatchToken !== dispatchToken || snapshot.data()?.shipdayOrderId) return;
        transaction.update(ref, { shipdayDispatchState: contacted && !definitiveRejection ? "reconciling" : "failed", shipdayDispatchError: contacted && !definitiveRejection ? "The delivery request outcome is uncertain. Confirm it in Shipday before retrying." : "The delivery request was rejected before creation." });
      }).catch(() => {});
      if (error?.statusCode) throw error;
      throw failure("The delivery request was interrupted. Confirm it in Shipday before retrying.", 502, "SHIPDAY_RECONCILING");
    }
  }

  async function testConnection() {
    const apiKey = options.getApiKey().trim();
    if (!configured(apiKey)) throw failure("Shipday API is not configured.", 503, "SHIPDAY_NOT_CONFIGURED");
    try {
      const response = await fetcher("https://api.shipday.com/orders", { method: "GET", redirect: "error", headers: { Authorization: "Basic " + apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? "Shipday rejected the configured API key." : "Shipday is temporarily unavailable.", 502);
      return { success: true, message: "Successfully connected to Shipday API" };
    } catch (error: any) {
      if (error?.statusCode) throw error;
      throw failure("Could not reach Shipday. Please retry shortly.", 502);
    }
  }

  async function processWebhook(payload: any) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure("Invalid webhook body.", 400);
    const nested = payload.order && typeof payload.order === "object" && !Array.isArray(payload.order) ? payload.order : {};
    const orderNumber = nested.order_number ?? nested.orderNumber ?? payload.orderNumber ?? payload.order_number;
    const externalId = providerId(nested.id ?? nested.orderId ?? payload.orderId ?? payload.order_id);
    const rawStatus = payload.order_status ?? payload.orderStatus ?? payload.status ?? nested.order_status ?? nested.status ?? payload.event;
    if (!validId(orderNumber) || !externalId || typeof rawStatus !== "string" || rawStatus.length > 80) throw failure("Invalid delivery event.", 400);
    const status = rawStatus.toUpperCase().replace(/[.\-\s]+/g, "_");
    const stamp = typeof payload.timestamp === "number" && Number.isSafeInteger(payload.timestamp) && payload.timestamp > 0 ? payload.timestamp : null;
    if (stamp !== null && stamp > Date.now() + 5 * 60000) throw failure("Invalid event timestamp.", 400);
    const ref = db.collection("orders").doc(orderNumber);
    let changed = false;
    await db.runTransaction(async (transaction: any) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return; // Never create order records from delivery webhooks.
      const current = snapshot.data() || {};
      if (String(current.shipdayOrderId || "") !== externalId) return;
      if (!orderCanBeFulfilled(current) || (current.fulfillmentType && current.fulfillmentType !== "delivery")) return;
      if (stamp !== null && Number(current.shipdayLastEventTimestamp || 0) >= stamp) return;
      if (["delivered", "cancelled"].includes(current.status)) return;
      if (!["ready", "dispatched"].includes(current.status)) return;
      const complete = ["ALREADY_DELIVERED", "ORDER_COMPLETED", "DELIVERY_COMPLETED", "COMPLETED", "DELIVERED"];
      const cancelled = ["FAILED_DELIVERY", "INCOMPLETE", "ORDER_FAILED", "ORDER_INCOMPLETE", "ORDER_DELETE", "ORDER_CANCELLED", "CANCELLED", "CANCELED", "DELETED"];
      const active = ["STARTED", "PICKED_UP", "READY_TO_DELIVER", "ORDER_ACCEPTED_AND_STARTED", "ORDER_ONTHEWAY", "ORDER_PIKEDUP", "DISPATCHED", "ON_THE_WAY", "IN_TRANSIT", "OUT_FOR_DELIVERY"];
      const nextStatus = complete.includes(status) ? "delivered" : cancelled.includes(status) ? "cancelled" : active.includes(status) ? "dispatched" : current.status;
      if (current.shipdayStatus === status && current.status === nextStatus) return;
      const now = new Date().toISOString();
      transaction.update(ref, { shipdayStatus: status, shipdayLastUpdate: now, ...(stamp !== null ? { shipdayLastEventTimestamp: stamp } : {}), ...(nextStatus !== current.status ? { status: nextStatus, updatedAt: now, statusHistory: [...(Array.isArray(current.statusHistory) ? current.statusHistory : []), { status: nextStatus, at: now }] } : {}) });
      changed = true;
    });
    return { success: true, changed };
  }

  return { create, testConnection, processWebhook, webhookToken: () => options.getWebhookToken() };
}

export function installShipdayRoutes(app: Express, service: ReturnType<typeof createShipdayService>, options: { requireStaffAuth: RequestHandler; requireStaffPermission: (permission: string) => RequestHandler }) {
  const reject = (res: any, error: any) => res.status(error?.statusCode || 502).json({ success: false, code: error?.code || "SHIPDAY_UNAVAILABLE", error: error?.statusCode ? error.message : "Shipday is temporarily unavailable." });
  app.post("/api/shipday/order", options.requireStaffAuth, options.requireStaffPermission("orders.updateStatus"), async (req, res) => {
    try {
      const requestedId = req.body?.orderData?.id ?? req.body?.orderId;
      if (!validId(requestedId)) throw failure("Stored order reference is required.", 400);
      res.json(await service.create(requestedId, req.body?.deliveryMinutes));
    } catch (error) { reject(res, error); }
  });
  app.get("/api/shipday/test", options.requireStaffAuth, options.requireStaffPermission("orders.updateStatus"), async (_req, res) => {
    try { res.json(await service.testConnection()); } catch (error) { reject(res, error); }
  });
  app.post("/api/shipday/webhook", async (req, res) => {
    const expected = service.webhookToken();
    if (!configured(expected)) return res.status(503).json({ error: "Delivery webhook is not configured." });
    // Shipday's documented header is `token`; retain the existing header/query
    // compatibility while keeping tokens and complete payloads out of logs.
    const supplied = req.get("token") ?? req.get("x-shipday-token") ?? req.query.token;
    if (!validShipdayWebhookToken(supplied, expected)) return res.status(401).json({ error: "Unauthorized" });
    try { return res.json(await service.processWebhook(req.body)); } catch (error) { return reject(res, error); }
  });
}
