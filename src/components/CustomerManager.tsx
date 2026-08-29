/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { 
  Users, Search, ShoppingBag, MapPin, Heart, ChevronRight, X, AlertCircle, CheckCircle, RefreshCw, Plus, Minus, Star
} from "lucide-react";
import { db, authedFetch } from "../firebase";
import { collection, onSnapshot } from "firebase/firestore";
import { UserProfile, Order } from "../types";
import { hasPermission, PermissionMap } from "../permissions";
import { logAudit } from "../utils/auditLogger";
import { confirmDialog } from "../notify";

interface CustomerManagerProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
  orders?: Order[];
  actor?: { email: string; role: string };
}

export default function CustomerManager({ 
  can, 
  permissions, 
  orders = [],
  actor
}: CustomerManagerProps) {
  const canView = can ? can("customers.view") : hasPermission(permissions, "customers.view");
  const canEditPoints = can ? can("customers.editPoints") : hasPermission(permissions, "customers.editPoints");

  const [customers, setCustomers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<UserProfile | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pointDelta, setPointDelta] = useState<string>("");
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }

    const unsub = onSnapshot(collection(db, "users"), (snapshot) => {
      const usersData = snapshot.docs.map(d => ({
        uid: d.id,
        ...(d.data() as any)
      })) as UserProfile[];
      setCustomers(usersData);
      setLoading(false);
    }, async (err) => {
      console.warn("Real-time listener on users failed, fetching via API:", err);
      try {
        const res = await authedFetch("/api/customers");
        if (res.ok) {
          const data = await res.json();
          setCustomers(data);
        }
      } catch (apiErr) {
        console.error("Failed to load customers via API:", apiErr);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, [canView]);

  const filteredCustomers = customers.filter(c => {
    const q = searchQuery.toLowerCase();
    return (
      (c.displayName && c.displayName.toLowerCase().includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q)) ||
      (c.uid && c.uid.toLowerCase().includes(q))
    );
  });

  const getCustomerOrders = (uid: string) => {
    return orders.filter(o => o.userId === uid || o.customerEmail?.toLowerCase() === selectedCustomer?.email?.toLowerCase());
  };

  const adjustPoints = async (delta: number) => {
    if (!selectedCustomer) return;
    if (delta === 0) return;

    const newValue = (selectedCustomer.points ?? 0) + delta;
    if (newValue < 0) {
      setStatusMessage({ type: 'error', text: 'Points cannot go below zero.' });
      return;
    }

    const actionLabel = delta > 0 ? 'Add' : 'Deduct';
    confirmDialog(
      `${actionLabel} ${Math.abs(delta)} loyalty point${Math.abs(delta) === 1 ? '' : 's'} ${delta > 0 ? 'to' : 'from'} ${selectedCustomer.email || selectedCustomer.displayName}? New balance will be ${newValue}.`,
      async () => {
        setAdjusting(true);
        setStatusMessage(null);
        try {
          const res = await authedFetch(`/api/customers/${selectedCustomer.uid}/points`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delta })
          });
          const data = await res.json();
          if (res.ok) {
            setStatusMessage({ type: 'success', text: `Points updated. New balance: ${data.points ?? newValue}` });
            // Optimistically update local snapshot
            setCustomers(prev => prev.map(c => c.uid === selectedCustomer.uid ? { ...c, points: data.points ?? newValue } : c));
            setSelectedCustomer(prev => prev ? { ...prev, points: data.points ?? newValue } : prev);
            await logAudit(actor || { email: 'system', role: 'admin' }, {
              action: `Adjusted loyalty points by ${delta > 0 ? '+' : ''}${delta}`,
              category: 'customer',
              targetId: selectedCustomer.uid,
              details: { email: selectedCustomer.email, from: selectedCustomer.points ?? 0, to: newValue, delta }
            });
          } else {
            setStatusMessage({ type: 'error', text: data.error || 'Failed to adjust points.' });
          }
        } catch (e: any) {
          setStatusMessage({ type: 'error', text: `Connection error: ${e?.message || 'Unknown error'}` });
        } finally {
          setAdjusting(false);
          setPointDelta("");
        }
      },
      null,
      `${actionLabel} Points`
    );
  };

  if (!canView) {
    return (
      <div className="p-8 bg-amber-50/60 border border-amber-200 rounded-2xl text-stone-700 text-center">
        <AlertCircle className="w-8 h-8 text-amber-600 mx-auto mb-2" />
        <h3 className="font-bold text-base text-stone-900">Access Restricted</h3>
        <p className="text-xs text-stone-600 mt-1">You need the "View customer profiles & history" permission to access this module.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Banner & Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm flex items-center space-x-4">
          <div className="p-3 bg-amber-50 text-amber-700 rounded-xl">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <p className="text-[11px] font-bold text-stone-400 uppercase tracking-wider">Total Customers</p>
            <p className="text-2xl font-bold font-serif text-stone-900">{customers.length}</p>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-sm flex items-center space-x-4">
          <div className="p-3 bg-blue-50 text-blue-700 rounded-xl">
            <ShoppingBag className="w-6 h-6" />
          </div>
          <div>
            <p className="text-[11px] font-bold text-stone-400 uppercase tracking-wider">Total Orders Placed</p>
            <p className="text-2xl font-bold font-serif text-stone-900">{orders.length}</p>
          </div>
        </div>
      </div>

      {/* Main Customers List Card */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-stone-50/50">
          <div>
            <h2 className="text-base font-bold font-serif text-stone-900">Registered Customer Accounts</h2>
            <p className="text-xs text-stone-500">View customer profiles, saved addresses, favorites, and order history</p>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              placeholder="Search by name, email..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-stone-400 text-xs">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-amber-500" />
            Loading customer accounts...
          </div>
        ) : filteredCustomers.length === 0 ? (
          <div className="p-12 text-center text-stone-400 text-xs">
            <Users className="w-8 h-8 mx-auto mb-2 text-stone-300" />
            {searchQuery ? "No customers found matching your search." : "No registered customers found yet."}
          </div>
        ) : (
          <div className="divide-y divide-stone-100 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-stone-50 text-stone-400 font-bold uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="px-5 py-3.5">Customer</th>
                  <th className="px-5 py-3.5">Total Orders</th>
                  <th className="px-5 py-3.5">Loyalty Points</th>
                  <th className="px-5 py-3.5">Joined</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {filteredCustomers.map(customer => {
                  const customerOrders = orders.filter(
                    o => o.userId === customer.uid || (customer.email && o.customerEmail?.toLowerCase() === customer.email.toLowerCase())
                  );
                  const initials = (customer.displayName || customer.email || "C")
                    .split(" ")
                    .map(n => n[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase();

                  return (
                    <tr key={customer.uid} className="hover:bg-amber-50/30 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 rounded-full bg-stone-900 text-amber-400 font-bold flex items-center justify-center text-xs shrink-0 shadow-sm">
                            {initials}
                          </div>
                          <div>
                            <p className="font-bold text-stone-900">{customer.displayName || "Customer"}</p>
                            <p className="text-[11px] text-stone-400 font-mono truncate max-w-[200px]">{customer.email || "No email"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 font-medium text-stone-700">
                        {customerOrders.length} order{customerOrders.length === 1 ? '' : 's'}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="inline-flex items-center space-x-1 text-amber-700 font-bold">
                          <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                          <span className="font-mono">{customer.points ?? 0}</span>
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-stone-400 text-[11px]">
                        {customer.createdAt ? (
                          new Date(customer.createdAt).toLocaleDateString()
                        ) : (
                          "Recent"
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <button
                          onClick={() => setSelectedCustomer(customer)}
                          className="px-3 py-1.5 bg-stone-900 hover:bg-stone-800 text-white rounded-lg text-[11px] font-bold transition-all shadow-sm cursor-pointer inline-flex items-center gap-1"
                        >
                          <span>Manage</span>
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Customer Detail Drawer / Modal */}
      {selectedCustomer && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex justify-end">
          <div className="bg-white w-full max-w-xl h-full shadow-2xl overflow-y-auto flex flex-col animate-in slide-in-from-right duration-200">
            {/* Drawer Header */}
            <div className="p-6 bg-stone-900 text-white flex items-start justify-between">
              <div className="flex items-center space-x-3">
                <div className="w-12 h-12 rounded-full bg-amber-500 text-stone-950 font-bold flex items-center justify-center text-base shadow-md">
                  {(selectedCustomer.displayName || selectedCustomer.email || "C")
                    .split(" ")
                    .map(n => n[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                </div>
                <div>
                  <h3 className="text-lg font-bold font-serif leading-tight">
                    {selectedCustomer.displayName || "Customer Profile"}
                  </h3>
                  <p className="text-xs text-stone-300 font-mono">{selectedCustomer.email}</p>
                </div>
              </div>
              <button
                onClick={() => {
                  setSelectedCustomer(null);
                  setStatusMessage(null);
                }}
                className="text-stone-400 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="p-6 space-y-6 flex-1">
              {/* Feedback Message */}
              {statusMessage && (
                <div className={`p-3.5 rounded-xl border flex items-center space-x-2 text-xs ${
                  statusMessage.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
                }`}>
                  {statusMessage.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                  <span>{statusMessage.text}</span>
                </div>
              )}

              {/* Customer Saved Addresses & Favorites */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl">
                  <div className="flex items-center space-x-2 text-stone-600 mb-1">
                    <MapPin className="w-3.5 h-3.5 text-stone-400" />
                    <span className="text-[11px] font-bold uppercase tracking-wider">Saved Addresses</span>
                  </div>
                  <p className="text-base font-bold text-stone-900">
                    {selectedCustomer.savedAddresses?.length || 0}
                  </p>
                </div>

                <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl">
                  <div className="flex items-center space-x-2 text-stone-600 mb-1">
                    <Heart className="w-3.5 h-3.5 text-rose-400" />
                    <span className="text-[11px] font-bold uppercase tracking-wider">Favorite Items</span>
                  </div>
                  <p className="text-base font-bold text-stone-900">
                    {selectedCustomer.favoriteItems?.length || 0}
                  </p>
                </div>
              </div>

              {/* Loyalty Points Adjustment */}
              {canEditPoints && (
                <div className="p-4 bg-amber-50/50 border border-amber-200 rounded-xl">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-bold text-sm text-stone-900 flex items-center space-x-1.5">
                      <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                      <span>Loyalty Points</span>
                    </h4>
                    <span className="font-mono font-bold text-amber-700 text-sm">{selectedCustomer.points ?? 0} pts</span>
                  </div>

                  <div className="flex items-center space-x-2">
                    <div className="flex-1 flex items-center space-x-2">
                      <input
                        type="number"
                        value={pointDelta}
                        onChange={e => setPointDelta(e.target.value)}
                        placeholder="Amount"
                        min={0}
                        className="w-full text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                    </div>
                    <button
                      onClick={() => adjustPoints(parseInt(pointDelta || "0", 10) || 0)}
                      disabled={adjusting || !pointDelta || (parseInt(pointDelta, 10) || 0) <= 0}
                      className="flex items-center space-x-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-3 py-2 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add</span>
                    </button>
                    <button
                      onClick={() => adjustPoints(-(parseInt(pointDelta || "0", 10) || 0))}
                      disabled={adjusting || !pointDelta || (parseInt(pointDelta, 10) || 0) <= 0}
                      className="flex items-center space-x-1 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold px-3 py-2 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <Minus className="w-3.5 h-3.5" />
                      <span>Deduct</span>
                    </button>
                  </div>
                  <p className="text-[10px] text-stone-500 mt-2">Adjust the customer's loyalty balance. Changes are recorded in the audit log.</p>
                </div>
              )}

              {/* Customer Order History */}
              <div className="space-y-3">
                <h4 className="font-bold text-sm text-stone-900 flex items-center justify-between">
                  <span>Order History</span>
                  <span className="text-xs font-normal text-stone-500 font-mono">
                    {getCustomerOrders(selectedCustomer.uid).length} total
                  </span>
                </h4>

                {getCustomerOrders(selectedCustomer.uid).length === 0 ? (
                  <div className="p-6 bg-stone-50 border border-stone-200 rounded-xl text-center text-xs text-stone-400">
                    No orders placed under this account yet.
                  </div>
                ) : (
                  <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                    {getCustomerOrders(selectedCustomer.uid).map(order => (
                      <div key={order.id} className="p-3.5 bg-stone-50 border border-stone-200 rounded-xl text-xs flex items-center justify-between">
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="font-mono font-bold text-stone-900">#{order.id}</span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                              order.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                              order.status === 'cancelled' ? 'bg-rose-100 text-rose-800' :
                              'bg-amber-100 text-amber-800'
                            }`}>
                              {order.status}
                            </span>
                          </div>
                          <p className="text-[11px] text-stone-400 mt-1">
                            {new Date(order.createdAt).toLocaleDateString()} · {order.items?.length || 0} items
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-stone-900 font-mono">
                            {order.total?.toFixed(2)} ETB
                          </p>
                          <span className={`text-[10px] font-bold uppercase ${order.paymentStatus === 'completed' ? 'text-emerald-600' : 'text-stone-400'}`}>
                            {order.paymentStatus}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
