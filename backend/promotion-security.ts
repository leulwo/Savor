/** Promotion capacity is claimed before a discounted hosted checkout exists. */
function promoError(code = "CHECKOUT_PROMO_LIMIT_REACHED") {
  return Object.assign(new Error(code === "CHECKOUT_PROMO_LIMIT_REACHED" ? "This promo code has reached its usage limit." : "This promo code changed. Review your cart and try again."), { statusCode: 409, code });
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function count(value: unknown): number {
  return value === undefined || value === null ? 0 : nonnegativeInteger(value) ?? Number.MAX_SAFE_INTEGER;
}

export function promotionCapacity(promo: any): boolean {
  if (!promo || promo.maxUsages === undefined || promo.maxUsages === null) return true;
  const maximum = nonnegativeInteger(promo.maxUsages);
  return maximum !== null && count(promo.usageCount) + count(promo.reservedCount) < maximum;
}

function subtotalOf(order: any): number {
  if (!Array.isArray(order.items)) throw promoError("CHECKOUT_PROMO_CHANGED");
  const subtotal = order.items.reduce((sum: number, line: any) => sum + Number(line.menuItem?.price) * Number(line.quantity), 0);
  if (!Number.isFinite(subtotal) || subtotal < 0) throw promoError("CHECKOUT_PROMO_CHANGED");
  return subtotal;
}

export function promotionDiscount(promo: any, subtotal: number, now = Date.now()): number {
  if (!promo || promo.active === false || !Number.isFinite(subtotal) || subtotal < 0) throw promoError("CHECKOUT_PROMO_CHANGED");
  if (promo.expiresAt) {
    const expires = typeof promo.expiresAt === "string" ? Date.parse(promo.expiresAt) : NaN;
    if (!Number.isFinite(expires) || expires <= now) throw promoError("CHECKOUT_PROMO_CHANGED");
  }
  const minimum = promo.minOrderAmount === undefined || promo.minOrderAmount === null ? 0 : Number(promo.minOrderAmount);
  if (!Number.isFinite(minimum) || minimum < 0 || subtotal < minimum) throw promoError("CHECKOUT_PROMO_CHANGED");
  const value = Number(promo.value);
  if (!Number.isFinite(value) || value < 0 || (promo.type === "percentage" && value > 100) || !["percentage", "fixed"].includes(promo.type)) throw promoError("CHECKOUT_PROMO_CHANGED");
  let discount = promo.type === "percentage" ? subtotal * value / 100 : value;
  if (promo.maxDiscount !== undefined && promo.maxDiscount !== null) {
    const maximum = Number(promo.maxDiscount);
    if (!Number.isFinite(maximum) || maximum < 0) throw promoError("CHECKOUT_PROMO_CHANGED");
    discount = Math.min(discount, maximum);
  }
  return Math.round(Math.min(subtotal, discount) * 100) / 100;
}

/** Return fields to include in the SAME order create/update transaction. */
export async function reserveOrderPromotion(transaction: any, db: any, order: any, now = Date.now()): Promise<Record<string, any>> {
  if (!order.promoCode || !(Number(order.discountAmount) > 0) || order.promoReserved || order.promoApplied) return {};
  const promoRef = db.collection("promoCodes").doc(String(order.promoCode));
  const snapshot = await transaction.get(promoRef);
  if (!snapshot.exists) throw promoError("CHECKOUT_PROMO_CHANGED");
  const promo = snapshot.data() || {};
  if (!promotionCapacity(promo)) throw promoError();
  const expectedDiscount = promotionDiscount(promo, subtotalOf(order), now);
  if (Math.abs(expectedDiscount - Number(order.discountAmount)) > 0.005) throw promoError("CHECKOUT_PROMO_CHANGED");
  transaction.update(promoRef, { reservedCount: count(promo.reservedCount) + 1 });
  return { promoReserved: true, promoReservedAt: new Date(now).toISOString() };
}

/** The settlement caller must merge these fields into its atomic paid update. */
export async function completeOrderPromotion(transaction: any, db: any, order: any, now = Date.now()): Promise<Record<string, any>> {
  if (!order.promoCode || !(Number(order.discountAmount) > 0) || order.promoApplied) return {};
  const promoRef = db.collection("promoCodes").doc(String(order.promoCode));
  const snapshot = await transaction.get(promoRef);
  if (!snapshot.exists) return { promoReserved: false, promoApplied: true, promoAppliedAt: new Date(now).toISOString() };
  const promo = snapshot.data() || {};
  // Already-created legacy checkouts must still be recorded as paid. New ones
  // have reserved capacity, so converting a reservation cannot exceed the cap.
  transaction.update(promoRef, {
    usageCount: count(promo.usageCount) + 1,
    ...(order.promoReserved ? { reservedCount: Math.max(0, count(promo.reservedCount) - 1) } : {})
  });
  return { promoReserved: false, promoApplied: true, promoAppliedAt: new Date(now).toISOString() };
}

/** Cash acceptance consumes capacity immediately, with no hosted reservation. */
export async function acceptCashOrderPromotion(transaction: any, db: any, order: any, now = Date.now()): Promise<Record<string, any>> {
  if (!order.promoCode || !(Number(order.discountAmount) > 0) || order.promoApplied) return {};
  const promoRef = db.collection("promoCodes").doc(String(order.promoCode));
  const snapshot = await transaction.get(promoRef);
  if (!snapshot.exists) throw promoError("CHECKOUT_PROMO_CHANGED");
  const promo = snapshot.data() || {};
  if (!promotionCapacity(promo)) throw promoError();
  if (Math.abs(promotionDiscount(promo, subtotalOf(order), now) - Number(order.discountAmount)) > 0.005) throw promoError("CHECKOUT_PROMO_CHANGED");
  transaction.update(promoRef, { usageCount: count(promo.usageCount) + 1 });
  return { promoApplied: true, promoAppliedAt: new Date(now).toISOString() };
}

/** Only call when the server proves no payable provider checkout can remain. */
export async function releaseOrderPromotion(transaction: any, db: any, order: any): Promise<Record<string, any>> {
  if (!order.promoReserved || order.promoApplied || !order.promoCode) return {};
  const promoRef = db.collection("promoCodes").doc(String(order.promoCode));
  const snapshot = await transaction.get(promoRef);
  if (snapshot.exists) transaction.update(promoRef, { reservedCount: Math.max(0, count(snapshot.data()?.reservedCount) - 1) });
  return { promoReserved: false };
}
