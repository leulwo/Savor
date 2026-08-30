import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, orderBy, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { toastError, confirmDialog } from '../notify';
import { Order } from '../types';
import { ChefHat, CheckCircle, Clock, Flame } from 'lucide-react';
import { hasPermission, PermissionMap } from '../permissions';

interface KitchenDisplaySystemProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

export default function KitchenDisplaySystem({ can, permissions }: KitchenDisplaySystemProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const isDue = (order: Order): boolean => {
    if (!order.scheduledFor) return true;
    const s = new Date(order.scheduledFor).getTime();
    if (isNaN(s)) return true;
    return s <= now;
  };

  const canStartPreparing = can ? can("kds.startPreparing") : hasPermission(permissions, "kds.startPreparing");
  const canMarkReady = can ? can("kds.markReady") : hasPermission(permissions, "kds.markReady");

  useEffect(() => {
    const q = query(
      collection(db, 'orders'),
      where('status', 'in', ['pending', 'preparing']),
      orderBy('createdAt', 'asc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const ordersData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Order));
      setOrders(ordersData);
      setLoading(false);
    }, (err) => {
      console.warn("KDS query error, falling back to simple query:", err);
      onSnapshot(collection(db, 'orders'), (snapshot) => {
        const ordersData = snapshot.docs
          .map(doc => ({ id: doc.id, ...doc.data() } as Order))
          .filter(o => o.status === 'pending' || o.status === 'preparing');
        setOrders(ordersData);
        setLoading(false);
      }, () => setLoading(false));
    });

    return () => unsubscribe();
  }, []);

  const updateOrderStatus = async (orderId: string, newStatus: string) => {
    confirmDialog(
      `Mark this order as "${newStatus.toUpperCase()}"?`,
      async () => {
        try {
          await updateDoc(doc(db, 'orders', orderId), {
            status: newStatus
          });
        } catch (error) {
          console.error("Failed to update order status:", error);
          toastError("Failed to update order status. If you are a staff member, make sure the " + newStatus + " permission is granted to your role.");
        }
      },
      null,
      newStatus === "ready" ? "Mark Ready" : "Start Preparing"
    );
  };

  const pendingOrders = (orders || []).filter(o => o?.status === 'pending' && isDue(o));
  const preparingOrders = (orders || []).filter(o => o?.status === 'preparing' && isDue(o));

  if (loading) {
    return <div className="p-8 text-center text-stone-500">Loading KDS...</div>;
  }

  const isPaidReady = (order: Order) =>
    order.paymentMethod === 'cash' || order.paymentStatus === 'completed';

  const fulfillmentMeta = (order: Order) => {
    const t = order.fulfillmentType || 'delivery';
    if (t === 'dineIn') return { label: 'DINE IN', cls: 'bg-purple-500/20 text-purple-300 border-purple-500/40', note: 'SERVE · NOT PACKAGED' };
    if (t === 'pickup') return { label: 'PICKUP', cls: 'bg-sky-500/20 text-sky-300 border-sky-500/40', note: 'PACKAGE LIGHT · NOT DELIVERED' };
    return { label: 'DELIVERY', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40', note: 'PACKAGE & HAND OFF' };
  };

  const scheduledNote = (order: Order) => {
    if (!order.scheduledFor) return null;
    try {
      const d = new Date(order.scheduledFor);
      if (isNaN(d.getTime())) return null;
      return `SCHEDULED ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (e) {
      return null;
    }
  };

  const formatOrderDate = (order: Order) => {
    try {
      const d = typeof order.createdAt === 'object' && (order.createdAt as any)?.toDate ? (order.createdAt as any).toDate() : new Date(order.createdAt);
      if (isNaN(d.getTime())) return 'Just now';
      return `${d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (e) {
      return 'Just now';
    }
  };

  return (
    <div className="bg-stone-900 rounded-2xl shadow-xl border border-stone-800 overflow-hidden min-h-[600px] text-white font-sans">
      <div className="p-4 border-b border-stone-800 bg-stone-950 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-amber-600 p-2 rounded-lg text-white">
            <ChefHat className="w-5 h-5" />
          </div>
          <h2 className="font-serif text-xl font-bold tracking-widest uppercase">Kitchen Display System</h2>
        </div>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-stone-800 h-full">
        {/* Pending / Received */}
        <div className="p-4 bg-stone-900/50">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-amber-500 uppercase tracking-widest text-sm">New Orders (Received)</h3>
            <span className="bg-stone-800 text-stone-400 font-mono text-xs px-2 py-0.5 rounded">{(pendingOrders || []).length}</span>
          </div>
          <div className="space-y-4">
            {(pendingOrders || []).map(order => (
              <div key={order.id} className="bg-stone-800 border-l-4 border-amber-500 rounded-lg p-4 shadow-sm animate-fade-in">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <span className="text-xs text-stone-400 font-mono">#{order.id}</span>
                    <h4 className="font-bold text-sm">{order.customerName || 'Guest'}</h4>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-stone-400 flex items-center">
                      <Clock className="w-3 h-3 mr-1" />
                      {formatOrderDate(order)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className={`text-[9px] font-mono capitalize tracking-wider px-2 py-0.5 rounded-full border ${fulfillmentMeta(order).cls}`}>
                    {fulfillmentMeta(order).label}
                  </span>
                  <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border border-fuchsia-500/40 text-fuchsia-300 bg-fuchsia-500/10">
                    {fulfillmentMeta(order).note}
                  </span>
                  {scheduledNote(order) && (
                    <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border border-orange-500/40 text-orange-300 bg-orange-500/10">
                      {scheduledNote(order)}
                    </span>
                  )}
                </div>

                <div className="bg-stone-900 p-3 rounded-lg mb-3">
                  <ul className="space-y-2">
                    {(order.items || []).map((item, idx) => (
                      <li key={idx} className="flex justify-between text-sm">
                        <span className="font-bold text-amber-400">{item.quantity || 1}x</span>
                        <span className="flex-1 ml-2 text-stone-200">{item.menuItem?.name || 'Dish'}{item.menuItem?.variation?.label ? ` — ${item.menuItem.variation.label}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                  {order.specialInstructions && (
                    <div className="mt-2 pt-2 border-t border-stone-800 text-rose-400 text-xs italic">
                      "Note: {order.specialInstructions}"
                    </div>
                  )}
                </div>
                
                {order.paymentMethod === 'chapa' && order.paymentStatus !== 'completed' ? (
                  <div className="w-full bg-stone-800 text-amber-500 border border-amber-500/30 text-center font-bold py-2 rounded-lg text-xs uppercase tracking-wider mb-2">
                    Waiting for Payment
                  </div>
                ) : canStartPreparing ? (
                  <button
                    onClick={() => updateOrderStatus(order.id, 'preparing')}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2 rounded-lg text-xs uppercase tracking-wider transition-colors cursor-pointer flex items-center justify-center space-x-2"
                  >
                    <Flame className="w-4 h-4" />
                    <span>Start Preparing</span>
                  </button>
                ) : (
                  <div className="w-full bg-stone-900 text-stone-400 border border-stone-700 text-center font-bold py-2 rounded-lg text-xs uppercase tracking-wider">
                    Waiting for Cashier to Start
                  </div>
                )}
              </div>
            ))}
            {(pendingOrders || []).length === 0 && (
              <div className="border-2 border-dashed border-stone-700 rounded-lg p-6 text-center text-stone-600 text-xs uppercase tracking-widest">
                No new orders
              </div>
            )}
          </div>
        </div>
        
        {/* Preparing */}
        <div className="p-4 bg-stone-900/20">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-blue-400 uppercase tracking-widest text-sm">Currently Preparing</h3>
            <span className="bg-stone-800 text-stone-400 font-mono text-xs px-2 py-0.5 rounded">{(preparingOrders || []).length}</span>
          </div>
          <div className="space-y-4">
            {(preparingOrders || []).map(order => (
              <div key={order.id} className="bg-stone-800 border-l-4 border-blue-500 rounded-lg p-4 shadow-sm animate-fade-in">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <span className="text-xs text-stone-400 font-mono">#{order.id}</span>
                    <h4 className="font-bold text-sm">{order.customerName || 'Guest'}</h4>
                    <span className="text-[11px] text-stone-500 flex items-center mt-0.5">
                      <Clock className="w-3 h-3 mr-1" />
                      {formatOrderDate(order)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border border-stone-700 text-stone-400">
                      {isPaidReady(order) ? 'PAID' : 'UNPAID'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className={`text-[9px] font-mono capitalize tracking-wider px-2 py-0.5 rounded-full border ${fulfillmentMeta(order).cls}`}>
                    {fulfillmentMeta(order).label}
                  </span>
                  <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border border-fuchsia-500/40 text-fuchsia-300 bg-fuchsia-500/10">
                    {fulfillmentMeta(order).note}
                  </span>
                  {scheduledNote(order) && (
                    <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border border-orange-500/40 text-orange-300 bg-orange-500/10">
                      {scheduledNote(order)}
                    </span>
                  )}
                </div>
                
                <div className="bg-stone-900 p-3 rounded-lg mb-3 opacity-80">
                  <ul className="space-y-2">
                    {(order.items || []).map((item, idx) => (
                      <li key={idx} className="flex justify-between text-sm">
                        <span className="font-bold text-blue-400">{item.quantity || 1}x</span>
                        <span className="flex-1 ml-2 text-stone-300">{item.menuItem?.name || 'Dish'}{item.menuItem?.variation?.label ? ` — ${item.menuItem.variation.label}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                  {order.specialInstructions && (
                    <div className="mt-2 pt-2 border-t border-stone-800 text-rose-400 text-xs italic">
                      "Note: {order.specialInstructions}"
                    </div>
                  )}
                </div>
                
                {canMarkReady ? (
                  <button
                    onClick={() => updateOrderStatus(order.id, 'ready')}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-lg text-xs uppercase tracking-wider transition-colors cursor-pointer flex items-center justify-center space-x-2"
                  >
                    <CheckCircle className="w-4 h-4" />
                    <span>Mark as Ready</span>
                  </button>
                ) : (
                  <div className="w-full bg-stone-900 text-stone-400 border border-stone-700 text-center font-bold py-2 rounded-lg text-xs uppercase tracking-wider">
                    Cannot mark ready
                  </div>
                )}
              </div>
            ))}
            {(preparingOrders || []).length === 0 && (
              <div className="border-2 border-dashed border-stone-700 rounded-lg p-6 text-center text-stone-600 text-xs uppercase tracking-widest">
                Nothing in the kitchen yet
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}