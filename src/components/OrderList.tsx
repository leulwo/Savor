/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { Order } from "../types";
import { ClipboardList, CheckCircle, Clock, Truck, Shield, AlertCircle, MoreVertical } from "lucide-react";
import { getLocalDateString, groupOrdersByDate } from "../App";
import { motion, AnimatePresence } from "motion/react";

interface OrderListProps {
  orders: Order[];
  onOrderUpdated: () => void;
  userRole?: string | null;
}

export default function OrderList({ orders = [], onOrderUpdated, userRole }: OrderListProps) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<Order | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [defaultDeliveryMinutes, setDefaultDeliveryMinutes] = useState<number>(20);

  const safeOrders = Array.isArray(orders) ? orders : [];

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        if (data && data.shipdayDeliveryMinutes) {
          setDefaultDeliveryMinutes(data.shipdayDeliveryMinutes);
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
      const res = await fetch(`/api/orders/${orderId}`, {
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
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleStatusChange = async (orderId: string, currentStatus: Order['status'], nextStatus: Order['status']) => {
    let deliveryMinutes = 0;
    if (nextStatus === "ready") {
      deliveryMinutes = defaultDeliveryMinutes;
    }
    updateStatus(orderId, nextStatus, undefined, deliveryMinutes);
  };

  const handleRefund = async (orderId: string, defaultAmount: number) => {
    const reasonPrompt = window.prompt(`Enter reason for refunding order ${orderId} (leave empty for "Customer request"):`);
    if (reasonPrompt === null) {
      return; // cancelled
    }
    const reason = reasonPrompt.trim() || "Customer request";

    const amountPrompt = window.prompt(`Enter amount to refund (max: ${defaultAmount} ETB):`, defaultAmount.toString());
    if (amountPrompt === null) {
      return; // cancelled
    }
    const amount = parseFloat(amountPrompt);
    if (isNaN(amount) || amount <= 0 || amount > defaultAmount) {
      alert("Invalid refund amount entered.");
      return;
    }

    if (!window.confirm(`Confirm refunding ${amount} ETB for order ${orderId}?`)) {
      return;
    }

    setLoadingId(orderId);
    try {
      const res = await fetch("/api/chapa/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txRef: orderId, amount, reason })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        alert(data.message || "Refund processed successfully!");
        onOrderUpdated();
      } else {
        alert("Refund failed: " + (data.error || "Unknown error"));
      }
    } catch (e: any) {
      alert("Error initiating refund: " + e.message);
      console.error(e);
    } finally {
      setLoadingId(null);
    }
  };

  const getStatusColor = (status: Order['status']) => {
    switch (status) {
      case "pending": return "bg-amber-100 text-amber-800 border-amber-200";
      case "preparing": return "bg-indigo-100 text-indigo-800 border-indigo-200";
      case "ready": return "bg-blue-100 text-blue-800 border-blue-200";
      case "delivered": return "bg-emerald-100 text-emerald-800 border-emerald-200";
      case "cancelled": return "bg-stone-100 text-stone-700 border-stone-200";
    }
  };

  const getPaymentStatusColor = (status: Order['paymentStatus']) => {
    switch (status) {
      case "completed": return "bg-emerald-100 text-emerald-800 border-emerald-200";
      case "pending": return "bg-amber-100 text-amber-800 border-amber-200";
      case "failed": return "bg-rose-100 text-rose-800 border-rose-200";
      case "refunded": return "bg-purple-100 text-purple-800 border-purple-200";
      default: return "bg-stone-100 text-stone-800 border-stone-200";
    }
  };

  return (
    <div id="admin-orders-list" className="bg-white border border-stone-200 rounded-2xl p-6 shadow-md font-sans">
      <div className="flex items-center space-x-2.5 border-b border-stone-100 pb-4 mb-5">
        <ClipboardList className="w-5.5 h-5.5 text-stone-800" />
        <div>
          <h3 className="font-serif text-lg font-bold text-stone-900">Gourmet Order Manager</h3>
          <p className="text-xs text-stone-500">Track online Chapa payments, Cash On Delivery, and order status securely.</p>
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
                      </div>

                      <div className="flex items-center space-x-2">
                        <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border ${getStatusColor(order.status)}`}>
                          Status: {order.status}
                        </span>
                        <span className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full border ${getPaymentStatusColor(order.paymentStatus)} flex items-center space-x-1`}>
                          <span>Pay: {order.paymentStatus === "completed" ? (order.paymentMethod === 'cash' ? "CASH PAID 💵" : "PAID ✅") : order.paymentStatus === "refunded" ? "REFUNDED ↩️" : (order.paymentStatus || "PENDING")}</span>
                          {(order.paymentStatus === "completed" || order.paymentStatus === "refunded") && (
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
                              href={order.shipdayTrackingLink}
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
                              Chapa Secure (ETB)
                            </>
                          ) : (
                            "Cash On Delivery"
                          )}
                        </span>
                        {order.transactionRef && (
                          <span className="font-mono text-[10px] text-slate-500 block mt-0.5 truncate max-w-[200px]">
                            Ref: {order.transactionRef}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center space-x-1.5">
                        {order.status === "pending" && (order.paymentMethod === 'cash' || order.paymentStatus === 'completed') && (
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
                        {order.status === "preparing" && (
                          <button
                            onClick={() => handleStatusChange(order.id, "preparing", "ready")}
                            disabled={loadingId === order.id}
                            className="bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors"
                          >
                            Finish Cooking (Ready)
                          </button>
                        )}
                        {order.paymentMethod === "cash" && order.paymentStatus === "pending" && (
                          <button
                            onClick={() => {
                              if (window.confirm("Mark this Cash order as PAID?")) {
                                updateStatus(order.id, order.status, "completed");
                              }
                            }}
                            disabled={loadingId === order.id}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-colors flex items-center"
                          >
                            <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                            Mark Paid
                          </button>
                        )}
                        {(order.status === "ready" || (order.shipdayOrderId && order.status === "preparing")) && (
                          <div className="flex items-center space-x-1.5 text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-1.5 rounded-lg border border-blue-100">
                            <Truck className="w-3 h-3" />
                            <span>DISPATCHED TO SHIPDAY</span>
                          </div>
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
                                  {order.paymentStatus === "pending" && order.paymentMethod === "cash" && (
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

                                  {order.paymentStatus === "completed" && order.paymentMethod === "chapa" && (
                                    <button
                                      onClick={() => {
                                        handleRefund(order.id, order.total);
                                        setActiveMenuId(null);
                                      }}
                                      disabled={loadingId === order.id}
                                      className="flex items-center px-4 py-2 text-xs text-purple-700 hover:bg-purple-50 transition-colors w-full text-left font-medium"
                                    >
                                      <AlertCircle className="w-3.5 h-3.5 mr-2" />
                                      Refund Chapa Order ↩️
                                    </button>
                                  )}

                                  {order.paymentStatus === "completed" && order.paymentMethod === "cash" && (
                                    <button
                                      onClick={() => {
                                        if (window.confirm("Mark this Cash order as REFUNDED for statistics?")) {
                                          updateStatus(order.id, order.status, "refunded");
                                        }
                                        setActiveMenuId(null);
                                      }}
                                      disabled={loadingId === order.id}
                                      className="flex items-center px-4 py-2 text-xs text-purple-700 hover:bg-purple-50 transition-colors w-full text-left font-medium"
                                    >
                                      <AlertCircle className="w-3.5 h-3.5 mr-2" />
                                      Mark as Refunded (Cash) ↩️
                                    </button>
                                  )}

                                  {order.status !== "delivered" && order.status !== "cancelled" && (
                                    <button
                                      onClick={() => {
                                        updateStatus(order.id, "cancelled");
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
        <div id="admin-receipt-modal" className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
          <div className="bg-amber-50/5 text-stone-900 rounded-2xl max-w-md w-full relative flex flex-col shadow-2xl border border-stone-200 overflow-hidden animate-scale-up max-h-[90vh]">
            {/* Paper receipt design */}
            <div className="bg-[#FAF9F6] p-6 flex-grow overflow-y-auto font-mono text-xs text-stone-800 space-y-6 select-none relative text-left">
              {/* Paper perforation top style */}
              <div className="absolute top-0 left-0 right-0 h-1.5 bg-[linear-gradient(45deg,transparent_33.333%,#FAF9F6_33.333%,#FAF9F6_66.667%,transparent_66.667%),linear-gradient(-45deg,transparent_33.333%,#FAF9F6_33.333%,#FAF9F6_66.667%,transparent_66.667%)] bg-[size:10px_10px] -mt-1"></div>
              
              {/* Receipt Header */}
              <div className="text-center space-y-2 mt-2">
                <h2 className="text-lg font-serif font-black tracking-tight text-stone-950 uppercase">Savory Restaurant</h2>
                <p className="text-[10px] text-stone-500 font-sans">100 Gourmet Way, Addis Ababa, Ethiopia</p>
                <p className="text-[10px] text-stone-500 font-sans">Tel: +251 911 234567</p>
                <div className="border-b border-dashed border-stone-300 my-4" />
                <h3 className="text-[11px] font-bold text-stone-950 tracking-wider">OFFICIAL TRANSACTION RECEIPT</h3>
                <p className={`text-[10px] font-bold ${selectedReceiptOrder.paymentStatus === "refunded" ? "text-purple-700" : "text-emerald-700"}`}>
                  STATUS: {selectedReceiptOrder.paymentStatus === "refunded" ? "REFUNDED" : "SECURELY PAID"}
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
                  <span className="text-stone-500">Chapa ID:</span>
                  <span className="font-mono text-stone-900 text-right max-w-[180px] truncate">{selectedReceiptOrder.receipt?.transactionId || `chapa-sim-${selectedReceiptOrder.id}`}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-stone-500">Method:</span>
                  <span className="font-semibold text-emerald-800 font-sans uppercase">{selectedReceiptOrder.receipt?.paymentMethod || "Chapa (CBE/Telebirr)"}</span>
                </div>
                {selectedReceiptOrder.paymentStatus === "refunded" && (
                  <div className="flex flex-col text-[11px] pt-1.5 mt-1.5 border-t border-dashed border-purple-200 text-purple-900 font-sans space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-purple-600 font-medium">Refund Status:</span>
                      <span className="font-bold uppercase">Success</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-purple-600">Refunded Amt:</span>
                      <span className="font-mono font-bold">{(selectedReceiptOrder as any).refund?.refundedAmount?.toFixed(2) || selectedReceiptOrder.total.toFixed(2)} ETB</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-purple-600">Reason:</span>
                      <span className="font-medium">{(selectedReceiptOrder as any).refund?.refundReason || "Customer request"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-purple-600">Refund Date:</span>
                      <span className="font-mono">{new Date((selectedReceiptOrder as any).refund?.refundedAt || selectedReceiptOrder.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                )}
                {selectedReceiptOrder.paymentMethod === "chapa" && (
                  <div className="flex justify-between items-center text-[11px] pt-1.5 mt-1.5 border-t border-stone-200/40">
                    <span className="text-stone-500 font-medium">Chapa Receipt:</span>
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
                    <img 
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&color=1c1917&data=${encodeURIComponent(
                        JSON.stringify({
                          orderId: selectedReceiptOrder.id,
                          name: selectedReceiptOrder.customerName,
                          total: `${selectedReceiptOrder.total.toFixed(2)} ETB`,
                          date: selectedReceiptOrder.receipt?.date || selectedReceiptOrder.createdAt,
                          payment: selectedReceiptOrder.receipt?.paymentMethod || "Chapa"
                        })
                      )}`} 
                      alt="Order QR Code" 
                      className="w-28 h-28"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                  <span className="text-[9px] font-mono text-stone-400 tracking-widest uppercase">Scan to Verify: {selectedReceiptOrder.id}</span>
                </div>
                <div className="space-y-1">
                  <p className="text-[11px] font-serif font-bold italic text-stone-950">Thank you for ordering!</p>
                  <p className="text-[10px] text-stone-400">Enjoy your gourmet meal.</p>
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
