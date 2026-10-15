/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from "react";
import { Order } from "../types";
import { db } from "../firebase";
import { doc, onSnapshot } from "../database";
import {
  DollarSign, ShoppingBag, TrendingUp, Users, Activity, Clock, Wallet,
  Utensils, ChefHat, FileText, Percent, Settings, CalendarDays, MessageSquare,
  AlertTriangle, ArrowRight, CheckCircle2, XCircle
} from "lucide-react";
import { format, startOfDay, endOfDay, isWithinInterval, parseISO, differenceInSeconds } from "date-fns";
import { scheduleAccepts } from "../utils/schedule";

interface OverviewDashboardProps {
  orders: Order[];
  can?: (key: string) => boolean;
  onNavigate?: (tab: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  preparing: "bg-blue-50 text-blue-700 border-blue-200",
  ready: "bg-violet-50 text-violet-700 border-violet-200",
  delivered: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cancelled: "bg-rose-50 text-rose-600 border-rose-200",
};

function parseOrderDate(order: Order): Date | null {
  if (!order?.createdAt) return null;
  try {
    const d = parseISO(order.createdAt);
    if (!isNaN(d.getTime())) return d;
    const d2 = new Date(order.createdAt);
    return isNaN(d2.getTime()) ? null : d2;
  } catch (e) {
    return null;
  }
}

export default function OverviewDashboard({ orders = [], can, onNavigate }: OverviewDashboardProps) {
  const [settings, setSettings] = useState<any>({});
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "settings", "global"),
      (snap) => {
        if (snap.exists()) {
          setSettings(snap.data());
        } else {
          setSettings({ scheduleEnabled: false, isOpen: true });
        }
        setSettingsLoaded(true);
      },
      () => {
        setSettings({ scheduleEnabled: false, isOpen: true });
        setSettingsLoaded(true);
      }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const schedule = useMemo(() => scheduleAccepts(settings, now), [settings, now]);

  // ---- Today's snapshot ----
  const todayOrders = useMemo(() => {
    const start = startOfDay(now);
    const end = endOfDay(now);
    return (orders || []).filter(o => {
      const d = parseOrderDate(o);
      return d ? isWithinInterval(d, { start, end }) : false;
    });
  }, [orders, now]);

  const todayStats = useMemo(() => {
    let net = 0;
    let gross = 0;
    let successful = 0;
    let failed = 0;
    let itemsSold = 0;
    const itemSales = new Map<string, { name: string; qty: number; revenue: number }>();
    const byStatus: Record<string, number> = {};

    todayOrders.forEach(o => {
      const refundLike = o.status === 'cancelled' || o.paymentStatus === 'failed' || o.paymentStatus === 'reversed';
      const amt = typeof o.total === 'number' ? o.total : 0;
      gross += amt;
      if (refundLike) {
        failed++;
      } else {
        net += amt;
        successful++;
        (o.items || []).forEach(item => {
          if (!item) return;
          const qty = item.quantity || 1;
          itemsSold += qty;
          const id = item.menuItem?.id || item.menuItemId || (item.menuItem?.name || 'unknown');
          const name = item.menuItem?.name || 'Dish';
          const price = item.menuItem?.price || 0;
          if (!itemSales.has(id)) itemSales.set(id, { name, qty: 0, revenue: 0 });
          const rec = itemSales.get(id)!;
          rec.qty += qty;
          rec.revenue += price * qty;
        });
      }
      byStatus[o.status || 'unknown'] = (byStatus[o.status || 'unknown'] || 0) + 1;
    });

    const topItem = Array.from(itemSales.values()).sort((a, b) => b.qty - a.qty)[0];
    return {
      orders: todayOrders.length,
      successful,
      failed,
      net,
      gross,
      itemsSold,
      avgOrder: successful > 0 ? net / successful : 0,
      topItem,
      byStatus,
    };
  }, [todayOrders]);

  const recentOrders = useMemo(() => {
    return [...todayOrders]
      .sort((a, b) => (parseOrderDate(b)?.getTime() || 0) - (parseOrderDate(a)?.getTime() || 0))
      .slice(0, 8);
  }, [todayOrders]);

  const quickLinks = [
    { tab: 'menu', label: 'Manage Menu', desc: 'Items, prices, categories', icon: Utensils, perm: 'menu.view' },
    { tab: 'orders', label: 'View Orders', desc: 'Incoming & live orders', icon: ShoppingBag, perm: 'orders.view' },
    { tab: 'kds', label: 'Kitchen Display', desc: 'Prep queue for the kitchen', icon: ChefHat, perm: 'kds.view' },
    { tab: 'reports', label: 'Reports', desc: 'Accounting & exports', icon: FileText, perm: 'reports.view' },
    { tab: 'reservations', label: 'Reservations', desc: 'Table bookings', icon: CalendarDays, perm: 'reservations.view' },
    { tab: 'marketing', label: 'Promotions', desc: 'Discounts & campaigns', icon: Percent, perm: 'promos.view' },
    { tab: 'chat', label: 'Customer Inbox', desc: 'Messages & requests', icon: MessageSquare, perm: 'chat.view' },
    { tab: 'settings', label: 'Team & Settings', desc: 'Staff, roles, schedule', icon: Settings, perm: 'settings.view' },
  ];

  const statusPill = !settingsLoaded
    ? { text: 'Checking schedule…', cls: 'bg-stone-100 text-stone-500 border-stone-200' }
    : settings?.scheduleEnabled
      ? schedule.accepting
        ? { text: 'Open — accepting orders', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
        : schedule.reason === 'notOpen'
          ? { text: 'Closed (before opening time)', cls: 'bg-rose-50 text-rose-600 border-rose-200' }
          : { text: 'Open but not accepting orders until next slot', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
      : settings?.isOpen
        ? { text: 'Open — accepting orders', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
        : { text: 'Store closed', cls: 'bg-rose-50 text-rose-600 border-rose-200' };

  return (
    <div className="space-y-6 font-sans">
      {/* Header strip */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="bg-amber-100 p-2 rounded-lg text-amber-700">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-serif text-lg font-bold text-stone-900">Today's Snapshot</h2>
            <p className="text-xs text-stone-500">{format(now, 'EEEE, MMMM d, yyyy')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border ${statusPill.cls}`}>
            {statusPill.text.includes('Open') ? <CheckCircle2 className="w-3.5 h-3.5" /> : statusPill.text.includes('Checking') ? <Clock className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          </span>
          {settings?.scheduleEnabled && (
            <span className="text-[10px] font-mono text-stone-400">
              {settings.openTime || '09:00'} – {settings.closeTime || '22:00'} · orders stop {settings.prepTimeMinutes || 30} min before close
            </span>
          )}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
          <DollarSign className="w-4 h-4 text-emerald-600 mb-2" />
          <p className="text-[10px] uppercase font-bold tracking-wider text-stone-500">Net Revenue</p>
          <p className="font-mono text-2xl font-bold text-stone-900">{todayStats.net.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETB</p>
          <p className="text-[10px] text-stone-400 mt-1">Gross: {todayStats.gross.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETB</p>
        </div>
        <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
          <ShoppingBag className="w-4 h-4 text-blue-600 mb-2" />
          <p className="text-[10px] uppercase font-bold tracking-wider text-stone-500">Orders Today</p>
          <p className="font-mono text-2xl font-bold text-stone-900">{todayStats.orders}</p>
          <p className="text-[10px] text-stone-400 mt-1">{todayStats.successful} successful · {todayStats.failed} failed</p>
        </div>
        <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
          <Wallet className="w-4 h-4 text-amber-600 mb-2" />
          <p className="text-[10px] uppercase font-bold tracking-wider text-stone-500">Avg Order Value</p>
          <p className="font-mono text-2xl font-bold text-stone-900">{todayStats.avgOrder.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETB</p>
          <p className="text-[10px] text-stone-400 mt-1">{todayStats.itemsSold} items sold</p>
        </div>
        <div className="bg-violet-50 border border-violet-100 rounded-xl p-4">
          <TrendingUp className="w-4 h-4 text-violet-600 mb-2" />
          <p className="text-[10px] uppercase font-bold tracking-wider text-stone-500">Top Item</p>
          <p className="text-base font-bold text-violet-900 truncate">{todayStats.topItem?.name || '—'}</p>
          <p className="text-[10px] text-violet-400 mt-1">{todayStats.topItem?.qty || 0} units · {todayStats.topItem?.revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETB</p>
        </div>
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
          <Users className="w-4 h-4 text-indigo-600 mb-2" />
          <p className="text-[10px] uppercase font-bold tracking-wider text-stone-500">Status Mix</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {Object.entries(todayStats.byStatus).map(([s, c]) => (
              <span key={s} className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${STATUS_COLOR[s] || 'bg-stone-100 text-stone-500 border-stone-200'}`}>
                {s}: {c}
              </span>
            ))}
            {Object.keys(todayStats.byStatus).length === 0 && <span className="text-[10px] text-stone-400">No orders yet</span>}
          </div>
        </div>
      </div>

      {/* Quick links */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-3">Quick Actions</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {quickLinks.filter(l => !l.perm || (can ? can(l.perm) : true)).map(link => (
            <button
              key={link.tab}
              onClick={() => onNavigate?.(link.tab)}
              className="bg-white border border-stone-200 rounded-xl p-4 text-left hover:border-amber-400 hover:shadow-sm transition-all group cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <link.icon className="w-4 h-4 text-amber-600" />
                <ArrowRight className="w-3.5 h-3.5 text-stone-300 group-hover:text-amber-500 transition-colors" />
              </div>
              <p className="text-sm font-bold text-stone-900 mt-2">{link.label}</p>
              <p className="text-[10px] text-stone-400">{link.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Recent activity */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-stone-100 bg-stone-50 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-stone-700 flex items-center">
            <Clock className="w-3.5 h-3.5 mr-2 text-amber-600" />
            Recent Orders
          </h3>
          {recentOrders.length > 0 && (can ? can('orders.view') : true) && (
            <button
              onClick={() => onNavigate?.('orders')}
              className="text-[10px] font-bold text-amber-700 hover:underline cursor-pointer"
            >
              View all →
            </button>
          )}
        </div>
        {recentOrders.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white border-b border-stone-100">
                  <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Time</th>
                  <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Order</th>
                  <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Customer</th>
                  <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Items</th>
                  <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Total</th>
                  <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {recentOrders.map(o => {
                  const d = parseOrderDate(o);
                  const items = (o.items || []).map(i => `${i.quantity || 1}x ${i.menuItem?.name || 'Dish'}`).join(', ');
                  const secondsAgo = d ? differenceInSeconds(now, d) : 0;
                  const age = secondsAgo < 60 ? `${secondsAgo}s` : secondsAgo < 3600 ? `${Math.floor(secondsAgo / 60)}m` : `${Math.floor(secondsAgo / 3600)}h`;
                  return (
                    <tr key={o.id} className="hover:bg-stone-50/60">
                      <td className="py-2.5 px-4 text-[11px] font-mono text-stone-500">{d ? format(d, 'HH:mm') : '--'} <span className="text-stone-300">({age} ago)</span></td>
                      <td className="py-2.5 px-4 text-[11px] font-mono font-bold text-stone-700">#{o.id.slice(-6)}</td>
                      <td className="py-2.5 px-4 text-xs text-stone-700">{o.customerName || 'Guest'}</td>
                      <td className="py-2.5 px-4 text-xs text-stone-500 max-w-[260px] truncate">{items || '—'}</td>
                      <td className="py-2.5 px-4 text-right text-xs font-mono font-bold text-emerald-600">{(o.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETB</td>
                      <td className="py-2.5 px-4">
                        <span className={`inline-block text-[9px] uppercase font-bold px-2 py-0.5 rounded-full border ${STATUS_COLOR[o.status || 'unknown'] || 'bg-stone-100 text-stone-500 border-stone-200'}`}>
                          {o.status || 'unknown'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center">
            <AlertTriangle className="w-8 h-8 text-stone-300 mx-auto mb-2" />
            <p className="text-xs text-stone-400">No orders yet today. When customers order, they'll appear here live.</p>
          </div>
        )}
      </div>
    </div>
  );
}