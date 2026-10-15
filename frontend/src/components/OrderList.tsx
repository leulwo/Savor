/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { Order } from "../types";
import { ClipboardList, CheckCircle, Clock, Truck, Shield, AlertCircle, MoreVertical } from "lucide-react";
import { getLocalDateString, groupOrdersByDate } from "../App";
import { motion, AnimatePresence } from "motion/react";
import { hasPermission, PermissionMap } from "../permissions";
import { confirmDialog } from "../notify";
import { logAudit } from "../utils/auditLogger";
import { authedFetch } from "../firebase";
import { getRestaurantName } from "../utils/businessName";
import { safeHttpsUrl } from "../utils/security";
import ReceiptQrCode from "./ReceiptQrCode";

interface OrderListProps {
  orders: Order[];
  onOrderUpdated: () => void;
  userRole?: string | null;
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
  actor?: { email: string; role: string };
}

export default function OrderList({ orders = [], onOrderUpdated, userRole, can, permissions, actor }: OrderListProps) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<Order | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [defaultDeliveryMinutes, setDefaultDeliveryMinutes] = useState<number>(20);
  const [receiptSettings, setReceiptSettings] = useState<{ businessEmail?: string; businessPhone?: string; businessAddress?: string; restaurantName?: string } | null>(null);
  const businessName = getRestaurantName(receiptSettings?.restaurantName);

  const canUpdateStatus = can ? can("orders.updateStatus") : hasPermission(permissions, "orders.updateStatus");
  const canMarkPaid = can ? can("orders.markPaid") : hasPermission(permissions, "orders.markPaid");
  const canCancel = can ? can("orders.cancel") : hasPermission(permissions, "orders.cancel");
  const canViewReceipts = can ? can("orders.receipts") : hasPermission(permissions, "orders.receipts");
  const canKds = can ? can("kds.markReady") || can("kds.startPreparing") : hasPermission(permissions, "kds.markReady") || hasPermission(permissions, "kds.startPreparing");
  const canAct = canUpdateStatus || canKds;

  const safeOrders = Array.isArray(orders) ? orders : [];

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await authedFetch("/api/settings");
        const data = await res.json();
        if (data && data.shipdayDeliveryMinutes) {
          setDefaultDeliveryMinutes(data.shipdayDeliveryMinutes);
        }
        if (data) {
          setReceiptSettings({
            businessEmail: data.businessEmail,
            businessPhone: data.businessPhone,
            businessAddress: data.businessAddress,
            restaurantName: data.restaurantName
          });
        }
      } catch (e) {
        console.error("Failed to load settings in OrderList", e);
      }
    };
    fetchSettings();
  }, []);

  const updateStatus = async (orderId: string, newStatus: Order['status'], newPaymentStatus?: Order['paymentStatus'], deliveryMinutes?: number) => {
    setLoadingId(orderId);
    try {
      const res = await authedFetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          paymentStatus: newPaymentStatus,
          deliveryMinutes: deliveryMinutes
        })
      });
      if (res.ok) {
        onOrderUpdated();
        const order = safeOrders.find(o => o.id === orderId);
        await logAudit(actor || { email: 'system', role: userRole || 'unknown' }, {
          action: 'Updated order',
          category: 'order',
          targetId: orderId,
          details: {
            status: { from: order?.status ?? null, to: newStatus ?? order?.status ?? null },
            paymentStatus: { from: order?.paymentStatus ?? null, to: newPaymentStatus ?? order?.paymentStatus ?? null },
            deliveryMinutes
          }
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleStatusChange = async (orderId: string, currentStatus: Order['status'], nextStatus: Order['status']) => {
    confirmDialog(
      `Mark this order as "${nextStatus.toUpperCase()}" (currently ${currentStatus.toUpperCase()})?`,
      () => {
        let deliveryMinutes = 0;
        if (nextStatus === "dispatched") {
          deliveryMinutes = defaultDeliveryMinutes;
        }
        updateStatus(orderId, nextStatus, undefined, deliveryMinutes);
      },
      null,
      nextStatus === "ready" ? "Mark Ready" : nextStatus === "dispatched" ? "Dispatch to Shipday" : nextStatus === "delivered" ? "Mark Delivered" : "Confirm"
    );
  };

  const getStatusColor = (status: Order['status']) => {
    switch (status) {
      case "pending": return "bg-amber-100 text-amber-800 border-amber-200";
      case "preparing": return "bg-indigo-100 text-indigo-800 border-indigo-200";
      case "ready": return "bg-sky-100 text-sky-800 border-sky-200";
      case "dispatched": return "bg-blue-100 text-blue-800 border-blue-200";
      case "delivered": return "bg-emerald-100 text-emerald-800 border-emerald-200";
      case "cancelled": return "bg-stone-100 text-stone-700 border-stone-200";
    }
  };

  const getPaymentStatusColor = (status: Order['paymentStatus']) => {
    switch (status) {
      case "completed": return "bg-emerald-100 text-emerald-800 border-emerald-200";
      case "pending": return "bg-amber-100 text-amber-800 border-amber-200";
      case "failed": return "bg-rose-100 text-rose-800 border-rose-200";
      case "reversed": return "bg-orange-100 text-orange-800 border-orange-200";
      default: return "bg-stone-100 text-stone-800 border-stone-200";
    }
  };

  return (
    <div id="admin-orders-list" className="bg-white border border-stone-200 rounded-2xl p-6 shadow-md font-sans">
      <div className="flex items-center space-x-2.5 border-b border-stone-100 pb-4 mb-5">
        <ClipboardList className="w-5.5 h-5.5 text-stone-800" />
        <div>
          <h3 className="font-serif text-lg font-bold text-stone-900">Gourmet Order Manager</h3>
        </div>
      </div>

      <div className="space-y-6 max-h-[600px] overflow-y-auto pr-2">
        {safeOrders.length === 0 ? (
          <div className="text-center py-12 text-stone-400">
            <ClipboardList className="w-12 h-12 mx-auto mb-3 text-stone-300 stroke-1" />
            <p className="text-sm font-medium">No orders recorded yet.</p>
            <p className="text-xs mt-1">Place an order from the front-end menu to generate records!</p>
          </div>
        ) : (
          Object.entries(groupOrdersByDate(safeOrders)).map(([dateGroup, groupOrders]) => (
            <div key={dateGroup} className="space-y-4">
              <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-md py-2 px-3 rounded-xl text-[11px] font-bold text-stone-600 tracking-wider uppercase flex justify-between items-center border border-stone-200/50 shadow-xs">
                <span>{dateGroup}</span>
                <span className="bg-stone-200 text-stone-700 px-2.5 py-0.5 rounded-full font-mono text-[10px]">
                  {(groupOrders || []).length} {(groupOrders || []).length === 1 ? 'order' : 'orders'}
                </span>
              </div>
              <div className="space-y-4">
                {(groupOrders || []).map((order) => (
                  <div key={order.id} className="border border-stone-150 rounded-xl p-4 hover:shadow-sm transition-all bg-stone-50/20">
                    {/* Order Meta Info */}
                    <div className="flex flex-wrap justify-between items-start gap-y-2 border-b border-stone-100 pb-3 mb-3">
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="font-mono text-xs font-bold text-stone-900 bg-stone-200 px-2 py-0.5 rounded">
                            ID: {order.id}
                          </span>
                          <span className="text-[11px] text-stone-500 font-mono">
                            {order.createdAt ? new Date(order.createdAt).toLocaleString() : 'N/A'}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center space-x-1.5 text-xs text-stone-600">
                          <span className="font-semibold text-stone-800">{order.customerName || 'Guest'}</span>
                          <span>•</span>
                          <span>{order.customerPhone || 'N/A'}</span>
                          <span>•</span>
                          <span className="truncate max-w-[150px]">{order.customerEmail || 'N/A'}</span>
                        </div>
                        {(order.fulfillmentType && order.fulfillmentType !== 'delivery') || order.scheduledFor ? (
                          <div className="mt-1.5 flex items-center flex-wrap gap-1.5">
                            {order.fulfillmentType && order.fulfillmentType !== 'delivery' && (
                              <span className={`text-[9px] font-mono uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border ${order.fulfillmentType === 'dineIn' ? 'bg-purple-50 text-purple-700 border-purple-300' : 'bg-sky-50 text-sky-700 border-sky-300'}`}>
                                {order.fulfillmentType === 'dineIn' ? 'Dine In · Serve in house' : 'Pickup · Not delivered'}
                              </span>
                            )}
                            {!order.fulfillmentType || order.fulfillmentType === 'delivery' ? (
                              <span className="text-[9px] font-mono uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-300">
                                Delivery
                              </span>
                            ) : null}
                            {order.scheduledFor && (
                              <span className="text-[9px] font-mono uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border bg-orange-50 text-orange-700 border-orange-300">
                                Scheduled · {new Date(order.scheduledFor).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                          </div>
                        ) : null}
                      </div>

                      <div className="flex items-center space-x-2">
                        <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border ${getStatusColor(order.status)}`}>
                          Status: {order.status}
                        </span>
                        <span className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full border ${getPaymentStatusColor(order.paymentStatus)} flex items-center space-x-1`}>
                          <span> {order.paymentStatus === "completed" ? (order.paymentMethod === 'cash' ? "CASH PAID 💵" : "PAID ✅") : order.paymentStatus === "reversed" ? "REVERSED ↩️" : order.paymentStatus === "failed" ? "FAILED ❌" : (order.paymentStatus || "PENDING")}</span>
                          {order.paymentStatus === "completed" && canViewReceipts && (
                            <button
                              onClick={() => setSelectedReceiptOrder(order)}
                              className="ml-1 bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 rounded px-1.5 py-0.5 text-[8px] font-extrabold uppercase transition-all cursor-pointer shadow-xs"
                              title="View Order Receipt"
                            >
                              Receipt 📄
                            </button>
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Items Breakdown */}
                    <div className="space-y-1 bg-stone-100/40 p-2.5 rounded-lg border border-stone-100/60 text-xs">
                      {(order.items || []).map((item, idx) => (
                        <div key={idx} className="flex justify-between text-stone-700">
                          <span>
                            <strong className="text-stone-900">{item.quantity || 1}x</strong> {item.menuItem?.name || "Dish"}
                          </span>
                          <span className="font-mono text-stone-500">
                            {(((item.menuItem?.price || 0)) * (item.quantity || 1)).toFixed(2)} ETB
                          </span>
                        </div>
                      ))}
                      <div className="border-t border-stone-200 mt-2 pt-1.5 flex justify-between font-bold text-stone-900">
                        <span>Order Total:</span>
                        <span className="font-mono text-amber-700 text-sm">{(order.total || 0).toFixed(2)} ETB</span>
                      </div>
                    </div>

                    {/* Delivery Details */}
                    {(order.blockNumber || order.roomNumber || order.googleMapsAddress) && (
                      <div className="mt-2 bg-stone-50/80 p-2.5 rounded-lg border border-stone-200 text-xs">
                        <span className="text-stone-500 uppercase tracking-wide text-[10px] block font-bold mb-0.5">Delivery Address</span>
                        <div className="text-stone-800 space-y-0.5">
                          {order.blockNumber && <div><span className="text-stone-500">Block:</span> {order.blockNumber}</div>}
                          {order.roomNumber && <div><span className="text-stone-500">Room:</span> {order.roomNumber}</div>}
                          {order.googleMapsAddress && <div><span className="text-stone-500">Address:</span> {order.googleMapsAddress}</div>}
                        </div>
                        {order.shipdayTrackingLink && (
                          <div className="mt-2 pt-2 border-t border-stone-200">
                            <a
                              href={safeHttpsUrl(order.shipdayTrackingLink)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center space-x-1.5 text-blue-600 hover:text-blue-800 font-bold uppercase text-[9px] tracking-wider transition-colors"
                            >
                              <Truck className="w-3.5 h-3.5" />
                              <span>Live Shipday Tracker</span>
                            </a>
                          </div>
                        )}
                      </div>
                    )}

                    {order.specialInstructions && (
                      <div className="mt-2 bg-amber-50/50 p-2.5 rounded-lg border border-amber-100 text-xs">
                        <span className="text-amber-800 uppercase tracking-wide text-[10px] block font-bold mb-0.5">Special Instructions</span>
                        <span className="text-stone-700 leading-relaxed italic">"{order.specialInstructions}"</span>
                      </div>
                    )}

                    {/* Payment details & Dispatch operations */}
                    <div className="mt-3.5 flex flex-wrap justify-between items-center gap-y-2 pt-1">
                      <div className="text-xs">
                        <span className="text-stone-500 uppercase tracking-wide text-[10px] block font-bold">Payment Channel</span>
                        <span className="font-semibold text-stone-800 flex items-center mt-0.5 capitalize">
                          {order.paymentMethod === "chapa" ? (
                            <>
                              <Shield className="w-3.5 h-3.5 text-emerald-600 mr-1" />
                              Online (ETB)
                            </>
                          ) : (
                            "Cash On Delivery"
                          )}
                        </span>

                      </div>

                      <div className="flex items-center space-x-1.5">
                        {order.status === "pending" && (order.paymentMethod === 'cash' || order.paymentStatus === 'completed') && canAct && (
                          <button
                            onClick={() => handleStatusChange(order.id, "pending", "preparing")}
                            disabled={loadingId === order.id}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors"
                          >
                            Start Preparing
                          </button>
                        )}
                        {order.status === "pending" && order.paymentMethod === 'chapa' && order.paymentStatus !== 'completed' && (
                          <span className="bg-stone-200 text-stone-600 text-[10px] font-bold px-3 py-1.5 rounded-lg border border-stone-300">
                            AWAITING PAYMENT
                          </span>
                        )}
                        {order.status === "preparing" && canAct && (
                          <button
                            onClick={() => handleStatusChange(order.id, "preparing", "ready")}
                            disabled={loadingId === order.id}
                            className="bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors"
                          >
                            Finish Cooking (Ready)
                          </button>
                        )}
                        {order.paymentMethod === "cash" && order.paymentStatus === "pending" && canMarkPaid && (
                          <button
                            onClick={() => {
                              confirmDialog("Mark this Cash order as PAID?", () => {
                                updateStatus(order.id, order.status, "completed");
                              }, null, "Mark as Paid");
                            }}
                            disabled={loadingId === order.id}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors flex items-center"
                          >
                            <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                            Mark Paid
                          </button>
                        )}
                        {(order.status === "ready" || (order.status === "dispatched") || (order.shipdayOrderId && order.status === "preparing")) && (
                          <div className="flex items-center space-x-1.5 text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-1.5 rounded-lg border border-blue-100">
                            <Truck className="w-3 h-3" />
                            <span>DISPATCHED TO SHIPDAY</span>
                          </div>
                        )}
                        {order.status === "ready" && !order.shipdayOrderId && canAct && (
                          order.fulfillmentType === 'delivery' ? (
                            <button
                              onClick={() => handleStatusChange(order.id, "ready", "dispatched")}
                              disabled={loadingId === order.id}
                              className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors flex items-center"
                            >
                              <Truck className="w-3.5 h-3.5 mr-1.5" />
                              Dispatch to Shipday
                            </button>
                          ) : (
                            <button
                              onClick={() => handleStatusChange(order.id, "ready", "delivered")}
                              disabled={loadingId === order.id}
                              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors flex items-center"
                            >
                              <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                              Mark as Delivered
                            </button>
                          )
                        )}
                        {(order.status === "dispatched" || (order.status === "ready" && !!order.shipdayOrderId)) && canAct && (
                          <button
                            onClick={() => {
                              const from = order.status === "dispatched" ? "dispatched" : "ready";
                              handleStatusChange(order.id, from as Order['status'], "delivered");
                            }}
                            disabled={loadingId === order.id}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors"
                          >
                            Mark Delivered
                          </button>
                        )}
                        {order.status === "delivered" && (
                          <div className="flex items-center space-x-1.5 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1.5 rounded-lg border border-emerald-100">
                            <CheckCircle className="w-3 h-3" />
                            <span>ORDER DELIVERED</span>
                          </div>
                        )}

                        <div className="relative">
                          <button
                            onClick={() => setActiveMenuId(activeMenuId === order.id ? null : order.id)}
                            className="p-1.5 hover:bg-stone-200 rounded-full transition-colors cursor-pointer text-stone-500 hover:text-stone-800"
                            title="More Actions"
                          >
                            <MoreVertical className="w-4.5 h-4.5" />
                          </button>

                          <AnimatePresence>
                            {activeMenuId === order.id && (
                              <>
                                <div
                                  className="fixed inset-0 z-20"
                                  onClick={() => setActiveMenuId(null)}
                                />
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, y: 10 }}
                                  animate={{ opacity: 1, scale: 1, y: 0 }}
                                  exit={{ opacity: 0, scale: 0.95, y: 10 }}
                                  className="absolute right-0 bottom-full mb-2 w-48 bg-white border border-stone-200 rounded-xl shadow-xl z-30 py-1.5 overflow-hidden flex flex-col"
                                >
                                  {order.paymentStatus === "pending" && order.paymentMethod === "cash" && canMarkPaid && (
                                    <button
                                      onClick={() => {
                                        updateStatus(order.id, order.status, "completed");
                                        setActiveMenuId(null);
                                      }}
                                      disabled={loadingId === order.id}
                                      className="flex items-center px-4 py-2 text-xs text-emerald-700 hover:bg-emerald-50 transition-colors w-full text-left font-medium"
                                    >
                                      <CheckCircle className="w-3.5 h-3.5 mr-2" />
                                      Mark as Paid (Cash)
                                    </button>
                                  )}

                                  {order.status !== "delivered" && order.status !== "cancelled" && canCancel && (
                                    <button
                                      onClick={() => {
                                        confirmDialog(
                                          "Cancel this order?\n\nThis cannot be undone. The customer will see the order as cancelled.",
                                          () => { updateStatus(order.id, "cancelled"); },
                                          () => {},
                                          "Cancel Order"
                                        );
                                        setActiveMenuId(null);
                                      }}
                                      disabled={loadingId === order.id}
                                      className="flex items-center px-4 py-2 text-xs text-rose-600 hover:bg-rose-50 transition-colors w-full text-left font-medium border-t border-stone-100"
                                    >
                                      <AlertCircle className="w-3.5 h-3.5 mr-2" />
                                      Cancel Order
                                    </button>
                                  )}

                                  {activeMenuId === order.id && (
                                    <div className="px-4 py-1.5 text-[9px] text-stone-400 font-mono border-t border-stone-100 mt-1">
                                      Order Ref: {order.id.slice(0, 8)}
                                    </div>
                                  )}
                                </motion.div>
                              </>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Chapa Transaction Receipt Modal Overlay */}
      {selectedReceiptOrder && (
        <div id="admin-receipt-modal" className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in" onClick={() => setSelectedReceiptOrder(null)}>
          <div className="bg-amber-50/5 text-stone-900 rounded-2xl max-w-md w-full relative flex flex-col shadow-2xl border border-stone-200 overflow-hidden animate-scale-up max-h-[90vh]" onClick={e => e.stopPropagation()}>
            {/* Paper receipt design */}
            <div className="bg-[#FAF9F6] p-6 flex-grow overflow-y-auto font-mono text-xs text-stone-800 space-y-6 select-none relative text-left">
              {/* Paper perforation top style */}
              <div className="absolute top-0 left-0 right-0 h-1.5 bg-[linear-gradient(45deg,transparent_33.333%,#FAF9F6_33.333%,#FAF9F6_66.667%,transparent_66.667%),linear-gradient(-45deg,transparent_33.333%,#FAF9F6_33.333%,#FAF9F6_66.667%,transparent_66.667%)] bg-[size:10px_10px] -mt-1"></div>

              {/* Receipt Header */}
              <div className="text-center space-y-2 mt-2">
                <h2 className="text-lg font-serif font-black tracking-tight text-stone-950 uppercase">{businessName}</h2>
                <p className="text-[10px] text-stone-500 font-sans">100 Gourmet Way, Addis Ababa, Ethiopia</p>
                <p className="text-[10px] text-stone-500 font-sans">Tel: +251 911 234567</p>
                <div className="border-b border-dashed border-stone-300 my-4" />
                <h3 className="text-[11px] font-bold text-stone-950 tracking-wider">OFFICIAL TRANSACTION RECEIPT</h3>
                <p className="text-[10px] font-bold text-emerald-700">
                  STATUS: PAID
                </p>
              </div>

              {/* Transaction Metadata */}
              <div className="space-y-1 bg-stone-100/60 p-3 rounded-lg border border-stone-200/50 font-sans">
                <div className="flex justify-between text-[11px]">
                  <span className="text-stone-500">Date:</span>
                  <span className="font-mono text-stone-900">{new Date(selectedReceiptOrder.receipt?.date || selectedReceiptOrder.createdAt).toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-stone-500">Tx Ref:</span>
                  <span className="font-mono text-stone-900">{selectedReceiptOrder.id}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-stone-500">Transaction ID:</span>
                  <span className="font-mono text-stone-900 text-right max-w-[180px] truncate">{selectedReceiptOrder.receipt?.transactionId || `chapa-sim-${selectedReceiptOrder.id}`}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-stone-500">Method:</span>
                  <span className="font-semibold text-emerald-800 font-sans uppercase">{selectedReceiptOrder.receipt?.paymentMethod || "Online (CBE/Telebirr)"}</span>
                </div>
                {selectedReceiptOrder.paymentMethod === "chapa" && (
                  <div className="flex justify-between items-center text-[11px] pt-1.5 mt-1.5 border-t border-stone-200/40">
                    <span className="text-stone-500 font-medium">Receipt:</span>
                    <a
                      href={`https://chapa.link/payment-receipt/${selectedReceiptOrder.receipt?.reference || selectedReceiptOrder.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-bold text-emerald-700 hover:text-emerald-800 underline flex items-center gap-0.5 cursor-pointer"
                    >
                      View Receipt ↗
                    </a>
                  </div>
                )}
              </div>

              {/* Customer Info */}
              <div className="space-y-1 text-[11px] font-sans border-t border-b border-dashed border-stone-300 py-3 text-left">
                <div className="flex justify-between">
                  <span className="text-stone-500">Customer:</span>
                  <span className="font-bold text-stone-900">{selectedReceiptOrder.customerName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-stone-500">Email:</span>
                  <span className="text-stone-900">{selectedReceiptOrder.customerEmail}</span>
                </div>
                {selectedReceiptOrder.customerPhone && (
                  <div className="flex justify-between">
                    <span className="text-stone-500">Phone:</span>
                    <span className="text-stone-900">{selectedReceiptOrder.customerPhone}</span>
                  </div>
                )}
                {(selectedReceiptOrder.blockNumber || selectedReceiptOrder.roomNumber) && (
                  <div className="flex justify-between">
                    <span className="text-stone-500">Deliver to:</span>
                    <span className="text-stone-900">Block {selectedReceiptOrder.blockNumber || "N/A"}, Room {selectedReceiptOrder.roomNumber || "N/A"}</span>
                  </div>
                )}
              </div>

              {/* Items Table */}
              <div className="space-y-2 text-left">
                <span className="text-[10px] font-bold text-stone-500 tracking-wider uppercase block">Order Details</span>
                <div className="space-y-1.5 font-sans">
                  {selectedReceiptOrder.items.map((item, idx) => (
                    <div key={idx} className="flex justify-between text-[11px]">
                      <span className="text-stone-800">{item.quantity}x {item.menuItem?.name || "Gourmet Dish"}</span>
                      <span className="font-mono text-stone-950 font-medium">{((item.menuItem?.price || 0) * item.quantity).toFixed(2)} ETB</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Fee Breakdown */}
              <div className="border-t border-stone-200 pt-3 space-y-1.5 text-[11px] font-sans text-left">
                {selectedReceiptOrder.serviceTax ? (
                  <div className="flex justify-between text-stone-500">
                    <span>Service Tax:</span>
                    <span className="font-mono">{selectedReceiptOrder.serviceTax.toFixed(2)} ETB</span>
                  </div>
                ) : null}
                {selectedReceiptOrder.flatFee ? (
                  <div className="flex justify-between text-stone-500">
                    <span>Flat Delivery Fee:</span>
                    <span className="font-mono">{selectedReceiptOrder.flatFee.toFixed(2)} ETB</span>
                  </div>
                ) : null}
                <div className="flex justify-between font-bold text-stone-950 text-xs border-t border-stone-200/60 pt-2 font-mono">
                  <span>TOTAL PAID:</span>
                  <span className="text-emerald-700">{selectedReceiptOrder.total.toFixed(2)} ETB</span>
                </div>
              </div>

              {/* QR Code and thank you */}
              <div className="text-center space-y-4 pt-4 border-t border-dashed border-stone-300">
                <div className="flex flex-col items-center justify-center space-y-1.5">
                  <div className="bg-white p-2 rounded-lg border border-stone-200 inline-block shadow-xs">
                    <ReceiptQrCode
                      value={JSON.stringify({
                          orderId: selectedReceiptOrder.id,
                          name: selectedReceiptOrder.customerName,
                          total: `${selectedReceiptOrder.total.toFixed(2)} ETB`,
                          date: selectedReceiptOrder.receipt?.date || selectedReceiptOrder.createdAt,
                            payment: selectedReceiptOrder.receipt?.paymentMethod || "Online"
                        })}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-stone-400 tracking-widest uppercase">Order details: {selectedReceiptOrder.id}</span>
                </div>
                <div className="space-y-1">
                  <p className="text-[11px] font-serif font-bold italic text-stone-950">Thank you for ordering!</p>
                  <p className="text-[10px] text-stone-400">Enjoy your gourmet meal.</p>
                  {(receiptSettings?.businessEmail || receiptSettings?.businessPhone || receiptSettings?.businessAddress) && (
                    <div className="pt-3 mt-2 border-t border-dashed border-stone-200 space-y-0.5 text-[9px] text-stone-500 font-sans">
                      <p className="font-bold text-stone-700 uppercase tracking-widest text-[8px]">{businessName}</p>
                      {receiptSettings?.businessAddress && <p>{receiptSettings.businessAddress}</p>}
                      {receiptSettings?.businessPhone && <p>Tel: {receiptSettings.businessPhone}</p>}
                      {receiptSettings?.businessEmail && <p className="break-all">{receiptSettings.businessEmail}</p>}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Modal Controls */}
            <div className="bg-stone-100 px-6 py-4 flex space-x-3 border-t border-stone-200">
              <button
                onClick={() => window.print()}
                className="flex-1 bg-stone-200 hover:bg-stone-300 text-stone-800 font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
              >
                <span>Print / Save PDF 🖨️</span>
              </button>
              <button
                onClick={() => setSelectedReceiptOrder(null)}
                className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
              >
                Close Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
