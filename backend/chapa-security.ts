import crypto from "node:crypto";
import { normalizeChapaMessage } from "./chapa-errors";

const MAX_PROVIDER_BODY_BYTES = 64 * 1024;
type ChapaMode = "test" | "live";
type ProviderReason = "not_found" | "unpaid" | "authorization" | "unavailable" | "invalid_response" | "rejected";

export function validPaymentReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{7,120}$/.test(value);
}

/** 7 uppercase alphanumeric characters (unambiguous, clean, Chapa-compatible) */
export function generateOrderId(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(7);
  let id = "";
  for (let i = 0; i < 7; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}

/** The browser must never be redirected to an arbitrary provider-controlled URL. */
export function isChapaCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.chapa.co" &&
      !url.port && !url.username && !url.password && !url.hash &&
      /^\/checkout\/(?:payment|test-payment)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Parse currency without Number coercion accepting null, arrays or booleans. Robust against float precision. */
export function paymentMinorUnits(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || value > 9999999.99) return null;
    const rounded = Math.round(value * 100);
    if (Math.abs(value - rounded / 100) > 1e-9) return null;
    return Number.isSafeInteger(rounded) && rounded > 0 && rounded <= 999_999_999 ? rounded : null;
  }
  const text = value.trim();
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 999_999_999 ? cents : null;
}

export function expectedChapaMode(secret: string): ChapaMode | null {
  if (/^CHASECK_TEST-[A-Za-z0-9_-]+$/.test(secret)) return "test";
  if (/^CHASECK-[A-Za-z0-9_-]+$/.test(secret)) return "live";
  return null;
}

export function isFinalPaymentStatus(value: unknown): boolean {
  return value === "completed" || value === "refunded" || value === "reversed";
}

export function isChapaAdjustmentStatus(value: unknown): value is "refunded" | "reversed" {
  return value === "refunded" || value === "reversed";
}

export function hasConfirmedChapaFailure(order: any): boolean {
  if (!order) return true;
  if (order.status === "cancelled" || order.paymentAttemptStatus === "cancelled" || order.paymentStatus === "failed") return true;
  return order.failureDefinitive === true && Boolean(order.initializationRejectedAt || order.providerCancelledAt || order.providerNotFoundConfirmedAt);
}

/** Read and create inside the same transaction to close distinct-ID races. */
export async function assertNewChapaAttemptCapacity(transaction: any, db: any, uid: string, currentTxRef?: string): Promise<void> {
  const pending = await transaction.get(db.collection("orders").where("userId", "==", uid).where("paymentMethod", "==", "chapa").where("paymentStatus", "==", "pending").limit(50));
  const unresolved = pending.docs.filter((document: any) => {
    if (currentTxRef && document.id === currentTxRef) return false;
    return !hasConfirmedChapaFailure(document.data());
  });
  if (unresolved.length >= 1) {
    throw Object.assign(new Error("You already have an order pending payment. Resume or cancel it before starting another checkout."), { statusCode: 409, code: "CHECKOUT_ACTIVE_ATTEMPT_LIMIT", retryAction: "wait" });
  }
}

/** Build only from provider verification data and a transaction-fresh order. */
export function buildVerifiedChapaAdjustment(payment: unknown, order: any, txRef: string, secret: string, responseStatus: string, now = new Date().toISOString()): Record<string, any> | null {
  const status = plainRecord(payment) && typeof payment.status === "string" ? payment.status.trim().toLowerCase() : "";
  if (!isChapaAdjustmentStatus(status)) return null;
  if (!chapaPaymentMatchDiagnostics(payment, order, txRef, secret, responseStatus).identityMatches) {
    throw Object.assign(new Error("Verified payment adjustment details do not match this order."), { statusCode: 409, code: "PAYMENT_DETAILS_MISMATCH" });
  }
  // An adjustment cannot manufacture a prior paid state, or replace a previous
  // terminal adjustment with a late or repeated provider response.
  if (order.paymentStatus !== "completed") return null;
  return {
    paymentStatus: status,
    paymentReconciliationRequired: false,
    paymentVerificationIssue: "",
    paymentAdjustedAt: now,
    fulfillmentHoldReason: "payment_" + status,
    failureReason: status === "refunded" ? "This payment was refunded. Contact the restaurant for help." : "This payment was reversed. Contact the restaurant for help.",
    ...(plainRecord(order.receipt) ? { receipt: { ...order.receipt, status } } : {}),
    updatedAt: now,
    paymentHistory: [...(Array.isArray(order.paymentHistory) ? order.paymentHistory : []), { paymentStatus: status, at: now }]
  };
}

/** null means unrelated verification; an empty patch means already terminal. */
export function buildChapaAdjustmentReconciliation(payment: unknown, order: any, txRef: string, secret: string, responseStatus: string, adjustmentExpected = false, now = new Date().toISOString()): Record<string, any> | null {
  const status = plainRecord(payment) && typeof payment.status === "string" ? payment.status.trim().toLowerCase() : "";
  if (!adjustmentExpected && !isChapaAdjustmentStatus(status)) return null;
  if (order?.paymentMethod !== "chapa" || isChapaAdjustmentStatus(order?.paymentStatus)) return {};
  if (isChapaAdjustmentStatus(status) && chapaPaymentMatchDiagnostics(payment, order, txRef, secret, responseStatus).identityMatches) {
    const adjustment = buildVerifiedChapaAdjustment(payment, order, txRef, secret, responseStatus, now);
    if (adjustment) return adjustment;
  }
  // Neither a signed event nor a malformed verification changes financial
  // truth. A hold stops value delivery while the provider result disagrees.
  return {
    paymentReconciliationRequired: true,
    paymentVerificationIssue: "payment_adjustment_unconfirmed",
    ...(order.paymentStatus !== "completed" ? { paymentAttemptStatus: "reconciling" } : {}),
    failureReason: "Chapa reported a payment adjustment. Fulfillment is paused while we verify it. Contact the restaurant for help.",
    updatedAt: now
  };
}

/** Call this against the order snapshot read INSIDE the settlement transaction. */
export function assertVerifiedChapaSettlement(payment: unknown, order: unknown, txRef: string, secret: string): void {
  if (!chapaPaymentMatchDiagnostics(payment, order, txRef, secret).matches) {
    throw Object.assign(new Error("Verified payment details do not match this order."), {
      statusCode: 409, code: "PAYMENT_DETAILS_MISMATCH"
    });
  }
}

function plainRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only safe booleans/statuses are returned for structured security logs. */
export function chapaPaymentMatchDiagnostics(payment: unknown, order: unknown, txRef: string, secret: string, responseStatus = "success") {
  const provider = plainRecord(payment) ? payment : {};
  const expected = plainRecord(order) ? order : {};
  const paymentStatus = typeof provider.status === "string" ? provider.status.trim().toLowerCase() : "";
  const response = typeof responseStatus === "string" ? responseStatus.trim().toLowerCase() : "";
  const providerRef = provider.tx_ref ?? provider.merchant_reference;
  const providerTxRefMatches = validPaymentReference(txRef) && providerRef === txRef &&
    (!expected.transactionRef || expected.transactionRef === txRef) &&
    (!expected.id || expected.id === txRef) && expected.paymentMethod === "chapa";
  const paid = paymentMinorUnits(provider.amount);
  const total = paymentMinorUnits(expected.total);
  const amountMatches = paid !== null && total !== null && paid === total;
  const currencyMatches = provider.currency === "ETB";
  const mode = typeof provider.mode === "string" ? provider.mode.toLowerCase() : "";
  const expectedMode = expectedChapaMode(secret);
  const modeMatches = expectedMode !== null && mode === expectedMode;
  const identityMatches = response === "success" && providerTxRefMatches && amountMatches && currencyMatches && modeMatches;
  return {
    matches: identityMatches && paymentStatus === "success",
    identityMatches,
    responseStatus: response.slice(0, 24), paymentStatus: paymentStatus.slice(0, 24),
    providerTxRefMatches, amountMatches, currencyMatches, modeMatches,
    expectedMode: expectedMode || "unknown"
  };
}

export function assertChapaWebhookSignature(rawBody: unknown, xSignature: unknown, chapaSignature: unknown, secret: string): boolean {
  if (!Buffer.isBuffer(rawBody) || !secret) return false;
  const payloadDigest = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const secretDigest = crypto.createHmac("sha256", secret).update(secret).digest();
  const equal = (supplied: unknown, expected: Buffer) => {
    if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied, "hex"), expected);
  };
  // Chapa documents payload signing plus a legacy static chapa-signature.
  // Any mutation after legacy authentication must still verify via the API.
  return equal(xSignature, payloadDigest) || equal(chapaSignature, payloadDigest) || equal(chapaSignature, secretDigest);
}

export function chapaProviderError(status: number, body: unknown): Error & { statusCode: number; providerStatus: number; providerReason: ProviderReason } {
  const text = normalizeChapaMessage(body).toLowerCase();
  const providerReason: ProviderReason = status === 401 || status === 403 ? "authorization"
    : status === 404 && /not paid|unpaid|pending/.test(text) ? "unpaid"
    : status === 404 && /invalid transaction|transaction not found|invalid reference|does not exist/.test(text) ? "not_found"
    : status >= 500 || status === 429 ? "unavailable" : "rejected";
  return Object.assign(new Error("Payment verification is temporarily unavailable."), {
    statusCode: status >= 500 || status === 429 ? 502 : 409,
    providerStatus: status, providerReason
  });
}

/** Bound upstream bodies, even when Content-Length is missing or compressed. */
export async function readChapaJsonResponse(response: Response, maxBytes = MAX_PROVIDER_BODY_BYTES): Promise<Record<string, any>> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("Chapa returned an invalid response."), { statusCode: 502, providerReason: "invalid_response" });
  }
  if (!response.body) throw Object.assign(new Error("Chapa returned an empty response."), { statusCode: 502, providerReason: "invalid_response" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("body_limit");
      }
      chunks.push(chunk.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!plainRecord(body)) throw new Error("body_shape");
    return body;
  } catch (error: any) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
    throw Object.assign(new Error("Chapa returned an invalid response."), { statusCode: 502, providerReason: "invalid_response" });
  } finally { reader.releaseLock(); }
}

/** Share repeated callback/webhook/browser checks; cap simultaneous egress. */
export function createChapaVerificationClient(getSecret: () => string, fetcher: typeof fetch = fetch) {
  const pending = new Map<string, Promise<Record<string, any>>>();
  const cached = new Map<string, { until: number; value: Record<string, any> }>();
  return async (txRef: string): Promise<Record<string, any>> => {
    if (!validPaymentReference(txRef)) throw Object.assign(new Error("Invalid payment reference."), { statusCode: 400 });
    const secret = getSecret();
    if (!expectedChapaMode(secret)) throw Object.assign(new Error("Chapa is not configured on the server."), { statusCode: 503 });
    // A key rotation may change account/mode: never share work across secrets.
    const cacheKey = crypto.createHash("sha256").update(secret).update("\0").update(txRef).digest("hex");
    const previous = cached.get(cacheKey);
    if (previous && previous.until > Date.now()) return previous.value;
    if (pending.has(cacheKey)) return pending.get(cacheKey)!;
    if (pending.size >= 100) throw Object.assign(new Error("Payment verification is busy. Please retry shortly."), { statusCode: 503 });
    for (const [key, entry] of cached) if (entry.until <= Date.now()) cached.delete(key);
    const task = (async () => {
      const response = await fetcher("https://api.chapa.co/v1/transaction/verify/" + encodeURIComponent(txRef), {
        method: "GET", redirect: "error",
        headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000)
      });
      const body = await readChapaJsonResponse(response);
      if (!response.ok) throw chapaProviderError(response.status, body);
      // Cache only bounded, parsed API data and only very briefly.
      if (cached.size >= 500) cached.delete(cached.keys().next().value!);
      cached.set(cacheKey, { until: Date.now() + 2000, value: body });
      return body;
    })();
    pending.set(cacheKey, task);
    try { return await task; } finally { pending.delete(cacheKey); }
  };
}

/** Invoke only after an authenticated owner explicitly requests cancellation. */
export async function cancelChapaTransaction(txRef: string, secret: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!validPaymentReference(txRef)) throw Object.assign(new Error("Invalid payment reference."), { statusCode: 400 });
  if (!expectedChapaMode(secret)) throw Object.assign(new Error("Chapa is not configured on the server."), { statusCode: 503 });
  const response = await fetcher("https://api.chapa.co/v1/transaction/cancel/" + encodeURIComponent(txRef), {
    method: "PUT", redirect: "error", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000)
  });
  const body = await readChapaJsonResponse(response);
  if (!response.ok || body.status !== "success") throw chapaProviderError(response.status, body);
}
