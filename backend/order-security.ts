type StaffPermissions = { role: string; permissions: Record<string, boolean>; disabled?: boolean } | null;

function rejection(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode, code: statusCode === 403 ? "ORDER_ACTION_FORBIDDEN" : "ORDER_UPDATE_REJECTED" });
}

export function orderCanBeFulfilled(order: any): boolean {
  return order?.paymentReconciliationRequired !== true && !order?.fulfillmentHoldReason &&
    (order?.paymentMethod === "cash" || (order?.paymentMethod === "chapa" && order?.paymentStatus === "completed"));
}

/** Build from the order snapshot read inside the caller's write transaction. */
export function buildStaffOrderUpdate(current: any, request: any, staff: StaffPermissions, now = new Date().toISOString()): Record<string, any> {
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some(key => !["status", "paymentStatus", "deliveryMinutes"].includes(key))) throw rejection("Only order status, cash payment completion and delivery minutes may be changed.", 400);
  const can = (permission: string) => !!staff && staff.disabled !== true && (staff.role === "admin" || staff.permissions?.[permission] === true);
  const updates: Record<string, any> = {};
  const knownStatuses = ["pending", "preparing", "ready", "dispatched", "delivered", "cancel_requested", "cancelled"];
  if (request.status !== undefined && (!knownStatuses.includes(request.status) || typeof request.status !== "string")) throw rejection("Invalid order status.", 400);
  if (request.paymentStatus !== undefined && !["pending", "completed", "refunded", "reversed"].includes(request.paymentStatus)) throw rejection("Invalid payment status.", 400);
  if (request.paymentStatus !== undefined && request.paymentStatus !== current.paymentStatus) {
    if (!can("orders.markPaid")) throw rejection("Your role cannot complete cash payments.", 403);
    if (current.paymentMethod !== "cash" || request.paymentStatus !== "completed" || current.paymentStatus !== "pending") throw rejection("Only pending cash payments can be completed manually. Online payment state requires provider verification.");
    if (["cancelled", "cancel_requested"].includes(current.status)) throw rejection("A cancelled order cannot be marked paid.");
    updates.paymentStatus = "completed";
    updates.paymentHistory = [...(Array.isArray(current.paymentHistory) ? current.paymentHistory : []), { paymentStatus: "completed", at: now }];
  }
  if (request.status !== undefined && request.status !== current.status) {
    const from = current.status;
    const to = request.status;
    if (["delivered", "cancelled"].includes(from)) throw rejection("This order is already closed.");
    const progress: Record<string, string[]> = {
      pending: ["preparing"], preparing: ["ready"], ready: ["dispatched"], dispatched: ["delivered"]
    };
    if (to === "cancelled") {
      if (!can("orders.cancel")) throw rejection("Your role cannot cancel orders.", 403);
      if (current.paymentMethod === "chapa" && current.paymentStatus === "pending" && current.failureDefinitive !== true) throw rejection("Resolve this uncertain payment before cancelling the order.");
      if (current.shipdayOrderId || ["sending", "reconciling"].includes(current.shipdayDispatchState)) throw rejection("Cancel the active delivery in Shipday before closing this order.");
    } else {
      if (!progress[from]?.includes(to)) throw rejection("This order status transition is not allowed.");
      const permitted = can("orders.updateStatus") || (from === "pending" && to === "preparing" && can("kds.startPreparing")) || (from === "preparing" && to === "ready" && can("kds.markReady"));
      if (!permitted) throw rejection("Your role cannot perform this order action.", 403);
      if (!orderCanBeFulfilled({ ...current, ...updates })) throw rejection("Online payment must be verified before fulfillment.");
    }
    updates.status = to;
    updates.statusHistory = [...(Array.isArray(current.statusHistory) ? current.statusHistory : []), { status: to, at: now }];
  }
  if (request.deliveryMinutes !== undefined && request.deliveryMinutes !== 0) {
    if (!Number.isInteger(request.deliveryMinutes) || request.deliveryMinutes < 1 || request.deliveryMinutes > 240) throw rejection("Delivery time must be a whole number between 1 and 240 minutes.", 400);
    if (request.deliveryMinutes !== current.deliveryMinutes) {
      if (!can("orders.updateStatus")) throw rejection("Your role cannot change delivery details.", 403);
      updates.deliveryMinutes = request.deliveryMinutes;
    }
  }
  return Object.keys(updates).length ? { ...updates, updatedAt: now } : {};
}
