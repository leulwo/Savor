import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, orderBy } from 'firebase/firestore';
import { Order } from '../types';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend, PieChart, Pie, Cell, AreaChart, Area
} from 'recharts';
import {
  TrendingUp, DollarSign, ShoppingBag, Activity, Calendar, Filter, RefreshCw,
  Users, Repeat, Clock, BadgePercent, Banknote, FileDown, Table2, CreditCard,
  ArrowUpRight, ArrowDownRight
} from 'lucide-react';
import {
  format, subDays, startOfDay, endOfDay, startOfWeek, startOfMonth,
  endOfMonth, startOfYear, isWithinInterval, parseISO,
  differenceInCalendarDays, getDay, getHours, addDays
} from 'date-fns';
import { downloadCsv, downloadXlsx, SheetRow } from '../utils/exportUtils';
import { toastError } from '../notify';

type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'month' | 'year' | 'all' | 'custom';

const COLORS = ['#D97706', '#059669', '#2563EB', '#DC2626', '#7C3AED', '#DB2777', '#0891B2', '#475569'];

function fmtNum(n: number): string {
  if (!isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const RANGE_PRESETS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' },
  { key: '90d', label: 'Last 90 Days' },
  { key: 'month', label: 'This Month' },
  { key: 'year', label: 'This Year' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: 'Custom' },
];

function resolveRange(key: RangeKey, customStart?: string, customEnd?: string): { start: Date; end: Date } | null {
  const now = new Date();
  switch (key) {
    case 'today':
      return { start: startOfDay(now), end: endOfDay(now) };
    case 'yesterday': {
      const y = subDays(now, 1);
      return { start: startOfDay(y), end: endOfDay(y) };
    }
    case '7d':
      return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    case '30d':
      return { start: startOfDay(subDays(now, 29)), end: endOfDay(now) };
    case '90d':
      return { start: startOfDay(subDays(now, 89)), end: endOfDay(now) };
    case 'month':
      return { start: startOfMonth(now), end: endOfDay(now) };
    case 'year':
      return { start: startOfYear(now), end: endOfDay(now) };
    case 'all':
      return { start: new Date(0), end: endOfDay(now) };
    case 'custom':
      if (customStart && customEnd) {
        return { start: startOfDay(parseISO(customStart)), end: endOfDay(parseISO(customEnd)) };
      }
      return { start: startOfDay(subDays(now, 6)), end: endOfDay(now) };
    default:
      return null;
  }
}

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

function isRefundedLike(order: Order): boolean {
  return order.status === 'cancelled' || order.paymentStatus === 'failed' || order.paymentStatus === 'reversed';
}

function itemsSummary(order: Order): { text: string; qty: number; subtotal: number } {
  let qty = 0;
  let subtotal = 0;
  const parts: string[] = [];
  (order?.items || []).forEach(item => {
    if (!item) return;
    const q = item.quantity || 1;
    qty += q;
    const price = item.menuItem?.price || 0;
    subtotal += price * q;
    parts.push(`${q}x ${item.menuItem?.name || 'Dish'}`);
  });
  return { text: parts.join(', '), qty, subtotal };
}

interface CustomerStat {
  key: string;
  name: string;
  email: string;
  phone: string;
  orders: number;
  revenue: number;
  avgOrder: number;
  lastOrder: string;
}

export default function AnalyticsDashboard({ can }: { can?: (key: string) => boolean }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d');
  const [customStart, setCustomStart] = useState<string>(format(subDays(new Date(), 6), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const canExport = can ? can("analytics.export") : true;
  const [paymentFilter, setPaymentFilter] = useState<string>('all'); // all | cash | chapa
  const [selectedDay, setSelectedDay] = useState<string | null>(null); // daily sheet drill-down
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'asc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const ordersData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Order));
      setOrders(ordersData);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const allCategories = useMemo(() => {
    const categories = new Set<string>();
    (orders || []).forEach(order => {
      (order?.items || []).forEach(item => {
        if (!item?.menuItem) return;
        if (Array.isArray(item.menuItem.categories)) {
          item.menuItem.categories.forEach(c => { if (c) categories.add(c); });
        } else if (item.menuItem.category) {
          categories.add(item.menuItem.category);
        }
      });
    });
    return Array.from(categories);
  }, [orders]);

  const range = useMemo(() => resolveRange(rangeKey, customStart, customEnd), [rangeKey, customStart, customEnd]);

  // Orders filtered by date range, category and payment method
  const filteredOrders = useMemo(() => {
    let list = orders || [];
    if (range) {
      list = list.filter(order => {
        const d = parseOrderDate(order);
        if (!d) return false;
        return isWithinInterval(d, { start: range.start, end: range.end });
      });
    }
    if (selectedCategory !== 'all') {
      list = list.filter(order =>
        (order?.items || []).some(item =>
          (Array.isArray(item?.menuItem?.categories) && item.menuItem.categories.includes(selectedCategory)) ||
          item?.menuItem?.category === selectedCategory
        )
      );
    }
    if (paymentFilter !== 'all') {
      list = list.filter(order => (order.paymentMethod || 'cash') === paymentFilter);
    }
    return list;
  }, [orders, range, selectedCategory, paymentFilter]);

  // All orders within range (ignoring category/payment filters) used for daily sheets
  const rangeOrders = useMemo(() => {
    if (!range) return orders || [];
    return (orders || []).filter(order => {
      const d = parseOrderDate(order);
      return d ? isWithinInterval(d, { start: range.start, end: range.end }) : false;
    });
  }, [orders, range]);

  // ====== aggregations ======
  const {
    kpis, chartData, categoryData, hourlyData, weekdayData, paymentMethodData,
    statusData, topItems, dailyRows, itemSalesData, prepStats, fulfillmentData
  } = useMemo(() => {
    let netRevenue = 0; // successful orders only
    let grossRevenue = 0; // all orders incl. failed/cancelled
    let ordersCount = 0;
    let successful = 0;
    let itemsSold = 0;
    let chapaRevenue = 0;
    let cashRevenue = 0;
    let failedCount = 0;

    const chartMap = new Map<string, any>();
    const categoryMap = new Map<string, number>();
    const itemsMap = new Map<string, { name: string; quantity: number; revenue: number }>();
    const hourlyMap: Record<number, { orders: number; revenue: number }> = {};
    const weekdayMap: Record<number, { orders: number; revenue: number }> = {};
    const paymentMap = new Map<string, number>();
    const statusMap = new Map<string, number>();
    const customerMap = new Map<string, CustomerStat>();
    const itemUnitMap = new Map<string, { name: string; quantity: number; revenue: number }>();
    const prepTimes: number[] = [];
    const prepTimeBins: Record<string, number> = {};

    (filteredOrders || []).forEach(order => {
      if (!order?.createdAt) return;
      const orderDate = parseOrderDate(order);
      if (!orderDate) return;

      ordersCount++;
      const totalAmount = typeof order.total === 'number' ? order.total : 0;
      grossRevenue += totalAmount;
      const totalQty = (order.items || []).reduce((acc, i) => acc + (i?.quantity || 1), 0);
      itemsSold += totalQty;

      // revenue classification
      const refundLike = isRefundedLike(order);
      if (refundLike) {
        if (order.paymentStatus === 'failed') failedCount++;
      } else {
        netRevenue += totalAmount;
        successful++;
        if ((order.paymentMethod || 'cash') === 'chapa') { chapaRevenue += totalAmount; } else { cashRevenue += totalAmount; }
        (order.items || []).forEach(item => {
          if (!item) return;
          const itemPrice = item.menuItem?.price || 0;
          const itemQty = item.quantity || 1;
          const cat = item.menuItem?.category || 'uncategorized';
          categoryMap.set(cat, (categoryMap.get(cat) || 0) + (itemQty * itemPrice));
          const itemId = item.menuItem?.id || item.menuItemId || item.menuItem?.name || 'unknown';
          const itemName = item.menuItem?.name || 'Dish';
          if (!itemsMap.has(itemId)) itemsMap.set(itemId, { name: itemName, quantity: 0, revenue: 0 });
          const itemData = itemsMap.get(itemId)!;
          itemData.quantity += itemQty;
          itemData.revenue += (itemQty * itemPrice);
          if (!itemUnitMap.has(itemId)) itemUnitMap.set(itemId, { name: itemName, quantity: 0, revenue: 0 });
          const u = itemUnitMap.get(itemId)!;
          u.quantity += itemQty;
          u.revenue += (itemQty * itemPrice);
        });
      }

      // charts keyed by day (when range <= 45 days) else by week/month
      const dayDiff = differenceInCalendarDays(range?.end || new Date(), range?.start || new Date());
      let dateKey = '';
      if (dayDiff <= 45) {
        dateKey = format(orderDate, 'yyyy-MM-dd');
      } else if (dayDiff <= 180) {
        dateKey = `Week of ${format(startOfWeek(orderDate), 'MMM dd')}`;
      } else if (dayDiff <= 400) {
        dateKey = format(orderDate, 'MMM yyyy');
      } else {
        dateKey = format(orderDate, 'yyyy');
      }
      if (dateKey) {
        if (!chartMap.has(dateKey)) chartMap.set(dateKey, { dateKey, Revenue: 0, Orders: 0, label: dateKey });
        const data = chartMap.get(dateKey)!;
        data.Orders++;
        if (!refundLike) {
          data.Revenue += totalAmount;
        }
      }

      // hourly + weekday (only meaningful for day/week granularity, limit to 30d)
      const hour = getHours(orderDate);
      hourlyMap[hour] = hourlyMap[hour] || { orders: 0, revenue: 0 };
      hourlyMap[hour].orders++;
      if (!refundLike) hourlyMap[hour].revenue += totalAmount;

      const wd = getDay(orderDate);
      weekdayMap[wd] = weekdayMap[wd] || { orders: 0, revenue: 0 };
      weekdayMap[wd].orders++;
      if (!refundLike) weekdayMap[wd].revenue += totalAmount;

      // payment method revenue (successful new ) by method
      const pm = order.paymentMethod || 'cash';
      paymentMap.set(pm, (paymentMap.get(pm) || 0) + (refundLike ? 0 : totalAmount));

      // status distribution
      const st = order.status || 'unknown';
      statusMap.set(st, (statusMap.get(st) || 0) + 1);

      // customer stats (successful orders)
      const custEmail = (order.customerEmail || '').trim().toLowerCase();
      const custKey = custEmail || (order.customerPhone || '').trim() || (order.customerName || 'Guest').toLowerCase();
      if (!refundLike) {
        if (!customerMap.has(custKey)) {
          customerMap.set(custKey, {
            key: custKey,
            name: order.customerName || 'Guest',
            email: order.customerEmail || '',
            phone: order.customerPhone || '',
            orders: 0,
            revenue: 0,
            avgOrder: 0,
            lastOrder: 'N/A'
          });
        }
        const c = customerMap.get(custKey)!;
        c.orders++;
        c.revenue += totalAmount;
        c.avgOrder = c.revenue / c.orders;
        c.lastOrder = format(orderDate, 'MMM dd, yyyy');
      }

      // prep time: time from createdAt -> "ready" (from statusHistory or first non-pending)
      const history = order.statusHistory || [];
      let readyAt: string | null = null;
      for (const h of history) {
        if (h.status === 'ready' || h.status === 'delivered') {
          readyAt = h.at;
          break;
        }
      }
      if (!readyAt && (order.status === 'ready' || order.status === 'delivered') && order.updatedAt) {
        readyAt = order.updatedAt;
      }
      if (readyAt) {
        const start = order.createdAt ? parseOrderDate(order) : null;
        const end = parseISO(readyAt);
        if (start && !isNaN(end.getTime())) {
          const mins = (end.getTime() - start.getTime()) / 60000;
          if (mins >= 0) prepTimes.push(Math.min(240, mins));
        }
      }
    });

    // ---- build chart data (sorted chronologically) ----
    let chartData: any[] = Array.from(chartMap.values());
    if (chartData.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(chartData[0].dateKey)) {
      chartData.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
      // fill gaps in daily view
      if (range && differenceInCalendarDays(range.end, range.start) <= 45 && chartData.length > 0) {
        const filled: any[] = [];
        let cursor = startOfDay(range.start);
        const endD = startOfDay(range.end);
        while (cursor <= endD) {
          const k = format(cursor, 'yyyy-MM-dd');
          const existing = chartData.find(d => d.dateKey === k);
          filled.push(existing || { dateKey: k, label: format(cursor, 'MMM dd'), Revenue: 0, Orders: 0 });
          cursor = addDays(cursor, 1);
        }
        chartData = filled;
      }
      chartData = chartData.map(d => ({ ...d, label: format(parseISO(d.dateKey), 'MMM dd') }));
    } else {
      chartData.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    }
    // ensure label exists
    chartData = chartData.map(d => ({ ...d, label: d.label || d.dateKey }));

    // ---- hourly ----
    const hourlyData: any[] = [];
    for (let h = 0; h < 24; h++) {
      const v = hourlyMap[h] || { orders: 0, revenue: 0 };
      hourlyData.push({ hour: `${String(h).padStart(2, '0')}:00`, orders: v.orders, revenue: v.revenue });
    }

    // ---- weekday ----
    const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekdayData: any[] = weekdayNames.map((name, i) => {
      const v = weekdayMap[i] || { orders: 0, revenue: 0 };
      return { name, orders: v.orders, revenue: v.revenue };
    });

    // ---- payment method ----
    const paymentMethodName: Record<string, string> = { chapa: 'Chapa (Online)', cash: 'Cash on Delivery' };
    const paymentMethodData: any[] = Array.from(paymentMap.entries()).map(([key, val]) => ({
      name: paymentMethodName[key] || key,
      key,
      value: val
    }));

    // ---- status distribution (ordered) ----
    const statusOrder = ['pending', 'preparing', 'ready', 'delivered', 'cancelled'];
    const statusData: any[] = statusOrder
      .map(s => ({ name: s.charAt(0).toUpperCase() + s.slice(1), count: statusMap.get(s) || 0 }))
      .filter(d => d.count > 0);

    // ---- categories / top items ----
    const categoryArray = Array.from(categoryMap.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);

    const topItemsArray = Array.from(itemsMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    const itemSalesArray = Array.from(itemUnitMap.values())
      .sort((a, b) => b.quantity - a.quantity);

    // ---- daily sheet rows (from rangeOrders so category filter doesn't hide days) ----
    const dailyMap = new Map<string, any>();
    (rangeOrders || []).forEach(order => {
      const d = parseOrderDate(order);
      if (!d) return;
      const k = format(d, 'yyyy-MM-dd');
      if (!dailyMap.has(k)) {
        dailyMap.set(k, {
          date: k, label: format(d, 'EEE, MMM d'), orders: 0, netRevenue: 0, grossRevenue: 0,
          chapa: 0, cash: 0, items: 0, avgOrder: 0
        });
      }
      const row = dailyMap.get(k);
      const amt = typeof order.total === 'number' ? order.total : 0;
      row.grossRevenue += amt;
      row.orders++;
      row.items += (order.items || []).reduce((acc, i) => acc + (i?.quantity || 1), 0);
      if (!isRefundedLike(order)) {
        row.netRevenue += amt;
        if ((order.paymentMethod || 'cash') === 'chapa') row.chapa += amt; else row.cash += amt;
      }
    });
    const dailyRows = Array.from(dailyMap.values())
      .map(r => ({ ...r, avgOrder: r.netRevenue / Math.max(1, r.orders) }))
      .sort((a, b) => b.date.localeCompare(a.date));

    // ---- prep stats ----
    prepTimes.forEach(m => {
      const bucket = m < 10 ? '<10m' : m < 20 ? '10-20m' : m < 30 ? '20-30m' : m < 45 ? '30-45m' : '45m+';
      prepTimeBins[bucket] = (prepTimeBins[bucket] || 0) + 1;
    });
    const fulfillmentData = Object.entries(prepTimeBins).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    const avgPrep = prepTimes.length ? prepTimes.reduce((a, b) => a + b, 0) / prepTimes.length : 0;

    return {
      kpis: {
        netRevenue, grossRevenue, ordersCount, successful, itemsSold,
        chapaRevenue, cashRevenue, failedCount, uniqueCustomers: customerMap.size,
        repeatCustomers: Array.from(customerMap.values()).filter(c => c.orders > 1).length,
        avgOrderValue: successful > 0 ? netRevenue / successful : 0
      },
      chartData, categoryData: categoryArray, hourlyData, weekdayData,
      paymentMethodData, statusData, topItems: topItemsArray,
      dailyRows, itemSalesData: itemSalesArray,
      prepStats: { avgPrep, sampleCount: prepTimes.length },
      fulfillmentData
    };
  }, [filteredOrders, rangeOrders, range]);

  const topCustomers: CustomerStat[] = useMemo(() => {
    const map = new Map<string, CustomerStat>();
    (filteredOrders || []).forEach(order => {
      if (isRefundedLike(order)) return;
      const d = parseOrderDate(order);
      if (!d) return;
      const custEmail = (order.customerEmail || '').trim().toLowerCase();
      const custKey = custEmail || (order.customerPhone || '').trim() || (order.customerName || 'Guest').toLowerCase();
      if (!map.has(custKey)) {
        map.set(custKey, {
          key: custKey, name: order.customerName || 'Guest', email: order.customerEmail || '',
          phone: order.customerPhone || '', orders: 0, revenue: 0, avgOrder: 0, lastOrder: 'N/A'
        });
      }
      const c = map.get(custKey)!;
      c.orders++;
      c.revenue += order.total || 0;
      c.avgOrder = c.revenue / c.orders;
      c.lastOrder = format(d, 'MMM dd, yyyy');
    });
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 8);
  }, [filteredOrders]);

  async function handleExport(type: 'csv' | 'xlsx', scope: 'transactions' | 'daily' | 'items' | 'customers') {
    setExporting(true);
    const dateStamp = format(new Date(), 'yyyy-MM-dd');
    try {
      const txColumns = [
        { key: 'date', label: 'Date' },
        { key: 'orderId', label: 'Order ID' },
        { key: 'customer', label: 'Customer' },
        { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' },
        { key: 'address', label: 'Address' },
        { key: 'items', label: 'Items' },
        { key: 'qty', label: 'Qty' },
        { key: 'subtotal', label: 'Subtotal (ETB)' },
        { key: 'serviceTax', label: 'Service Tax (ETB)' },
        { key: 'flatFee', label: 'Delivery Fee (ETB)' },
        { key: 'discount', label: 'Discount (ETB)' },
        { key: 'total', label: 'Total (ETB)' },
        { key: 'paymentMethod', label: 'Payment Method' },
        { key: 'paymentStatus', label: 'Payment Status' },
        { key: 'orderStatus', label: 'Order Status' },
        { key: 'promo', label: 'Promo Code' }
      ];

      if (scope === 'transactions') {
        const rows: SheetRow[] = (rangeOrders || [])
          .filter(o => selectedDay ? format(parseOrderDate(o) || new Date(), 'yyyy-MM-dd') === selectedDay : true)
          .sort((a, b) => (parseOrderDate(a)?.getTime() || 0) - (parseOrderDate(b)?.getTime() || 0))
          .map(o => {
            const d = parseOrderDate(o);
            const sum = itemsSummary(o);
            return {
              date: d ? format(d, 'yyyy-MM-dd HH:mm') : '',
              orderId: o.id,
              customer: o.customerName || 'Guest',
              phone: o.customerPhone || '',
              email: o.customerEmail || '',
              address: [o.blockNumber, o.roomNumber].filter(Boolean).join(' | ') || o.googleMapsAddress || '',
              items: sum.text,
              qty: sum.qty,
              subtotal: round(sum.subtotal),
              serviceTax: round(o.serviceTax || 0),
              flatFee: round(o.flatFee || 0),
              discount: round(o.discountAmount || 0),
              total: round(o.total || 0),
              paymentMethod: o.paymentMethod === 'chapa' ? 'Chapa' : 'Cash',
              paymentStatus: o.paymentStatus || 'pending',
              orderStatus: o.status || 'unknown',
              promo: o.promoCode || ''
            };
          });
        if (type === 'csv') {
          const fname = `Savory_Transactions_${dateStamp}.csv`;
          downloadCsv(fname, rows, txColumns);
        } else {
          await downloadXlsx(`Savory_Transactions_${dateStamp}.xlsx`, [
            { name: 'Transactions', rows, columns: txColumns },
            { name: 'Daily Summary', rows: dailyExportRows(), columns: dailyColumns() }
          ]);
        }
      } else if (scope === 'daily') {
        const rows = dailyExportRows();
        if (type === 'csv') downloadCsv(`Savory_DailySummary_${dateStamp}.csv`, rows, dailyColumns());
        else await downloadXlsx(`Savory_DailySummary_${dateStamp}.xlsx`, [{ name: 'Daily Summary', rows, columns: dailyColumns() }]);
      } else if (scope === 'items') {
        const rows: SheetRow[] = (itemSalesData || []).map(i => ({
          item: i.name,
          quantity: i.quantity,
          revenue: round(i.revenue)
        }));
        const cols = [
          { key: 'item', label: 'Item' },
          { key: 'quantity', label: 'Units Sold' },
          { key: 'revenue', label: 'Revenue (ETB)' }
        ];
        if (type === 'csv') downloadCsv(`Savory_Items_${dateStamp}.csv`, rows, cols);
        else await downloadXlsx(`Savory_Items_${dateStamp}.xlsx`, [{ name: 'Items', rows, columns: cols }]);
      } else if (scope === 'customers') {
        const rows: SheetRow[] = (topCustomers || []).map(c => ({
          name: c.name, email: c.email, phone: c.phone, orders: c.orders,
          revenue: round(c.revenue), avgOrder: round(c.avgOrder), lastOrder: c.lastOrder
        }));
        const cols = [
          { key: 'name', label: 'Customer' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
          { key: 'orders', label: 'Orders' }, { key: 'revenue', label: 'Revenue (ETB)' },
          { key: 'avgOrder', label: 'Avg Order (ETB)' }, { key: 'lastOrder', label: 'Last Order' }
        ];
        if (type === 'csv') downloadCsv(`Savory_Customers_${dateStamp}.csv`, rows, cols);
        else await downloadXlsx(`Savory_Customers_${dateStamp}.xlsx`, [{ name: 'Customers', rows, columns: cols }]);
      }
    } catch (e) {
      console.error('Export failed', e);
      toastError('Export failed: ' + (e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  function dailyExportRows(): SheetRow[] {
    return (dailyRows || []).map(r => ({
      date: r.date,
      day: r.label,
      orders: r.orders,
      items: r.items,
      netRevenue: round(r.netRevenue),
      grossRevenue: round(r.grossRevenue),
      chapa: round(r.chapa),
      cash: round(r.cash),
      avgOrder: round(r.avgOrder)
    }));
  }
  function dailyColumns() {
    return [
      { key: 'date', label: 'Date' }, { key: 'day', label: 'Day' }, { key: 'orders', label: 'Orders' },
      { key: 'items', label: 'Items Sold' }, { key: 'netRevenue', label: 'Net Revenue (ETB)' },
      { key: 'grossRevenue', label: 'Gross Revenue (ETB)' }, { key: 'chapa', label: 'Chapa (ETB)' },
      { key: 'cash', label: 'Cash (ETB)' }, { key: 'avgOrder', label: 'Avg Order (ETB)' }
    ];
  }
  function round(n: number) { return Math.round(n * 100) / 100; }

  const rangeLabel = useMemo(() => {
    if (!range) return 'Range';
    if (rangeKey === 'all') return 'All Time';
    return `${format(range.start, 'MMM d, yyyy')} – ${format(range.end, 'MMM d, yyyy')}`;
  }, [range, rangeKey]);

  if (loading) {
    return <div className="p-12 text-center text-stone-500 flex flex-col items-center"><RefreshCw className="w-8 h-8 animate-spin mb-4" />Loading analytics...</div>;
  }

  const kpi = kpis;
  const chapaShare = kpi.netRevenue > 0 ? (kpi.chapaRevenue / kpi.netRevenue) * 100 : 0;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden font-sans">
      {/* ===== Header / Controls ===== */}
      <div className="p-5 border-b border-stone-100 flex flex-col lg:flex-row lg:items-center justify-between bg-stone-50 gap-4">
        <div className="flex items-center space-x-3">
          <div className="bg-amber-100 p-2 rounded-lg text-amber-700">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-serif text-lg font-bold text-stone-900">Analytics &amp; Reports</h2>
            <p className="text-xs text-stone-500">{rangeLabel} · {kpi.ordersCount} orders · {fmtNum(kpi.netRevenue)} ETB net</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Range presets */}
          <div className="flex flex-wrap items-center gap-1 bg-white border border-stone-300 rounded-lg p-1">
            {RANGE_PRESETS.slice(0, 8).map(p => (
              <button
                key={p.key}
                onClick={() => setRangeKey(p.key)}
                className={`px-2.5 py-1.5 rounded text-[11px] font-bold transition-colors cursor-pointer ${rangeKey === p.key ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={() => setRangeKey('custom')}
              className={`px-2.5 py-1.5 rounded text-[11px] font-bold transition-colors cursor-pointer flex items-center gap-1 ${rangeKey === 'custom' ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'}`}
            >
              <Calendar className="w-3 h-3" /> Custom
            </button>
          </div>

          {rangeKey === 'custom' && (
            <div className="flex items-center gap-1.5 bg-white border border-stone-300 rounded-lg px-2 py-1">
              <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} className="text-xs border border-stone-200 rounded px-2 py-1" />
              <span className="text-xs text-stone-400">→</span>
              <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="text-xs border border-stone-200 rounded px-2 py-1" />
            </div>
          )}

          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            className="text-xs border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-amber-500 outline-none"
          >
            <option value="all">All Categories</option>
            {(allCategories || []).map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <select
            value={paymentFilter}
            onChange={e => setPaymentFilter(e.target.value)}
            className="text-xs border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-amber-500 outline-none"
          >
            <option value="all">All Payments</option>
            <option value="chapa">Chapa (Online)</option>
            <option value="cash">Cash on Delivery</option>
          </select>

          {/* Export menu */}
          {canExport && (
            <div className="relative group">
            <button
              disabled={exporting}
              onClick={() => handleExport('xlsx', 'transactions')}
              className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold px-3 py-2 rounded-lg transition-colors cursor-pointer"
            >
              <FileDown className="w-3.5 h-3.5" />
              {exporting ? 'Exporting...' : 'Export Sheet'}
            </button>
            <div className="hidden group-hover:flex absolute right-0 top-full mt-1 z-30 flex-col bg-white border border-stone-200 rounded-xl shadow-xl overflow-hidden w-52">
              <button onClick={() => handleExport('xlsx', 'transactions')} className="text-left px-4 py-2.5 text-xs font-medium text-stone-700 hover:bg-amber-50 transition-colors cursor-pointer">Transactions → Excel (.xlsx)</button>
              <button onClick={() => handleExport('csv', 'transactions')} className="text-left px-4 py-2.5 text-xs font-medium text-stone-700 hover:bg-amber-50 transition-colors cursor-pointer">Transactions → CSV</button>
              <div className="border-t border-stone-100" />
              <button onClick={() => handleExport('xlsx', 'daily')} className="text-left px-4 py-2.5 text-xs font-medium text-stone-700 hover:bg-amber-50 transition-colors cursor-pointer">Daily Summary → Excel</button>
              <button onClick={() => handleExport('csv', 'daily')} className="text-left px-4 py-2.5 text-xs font-medium text-stone-700 hover:bg-amber-50 transition-colors cursor-pointer">Daily Summary → CSV</button>
              <div className="border-t border-stone-100" />
              <button onClick={() => handleExport('xlsx', 'items')} className="text-left px-4 py-2.5 text-xs font-medium text-stone-700 hover:bg-amber-50 transition-colors cursor-pointer">Items Sold → Excel</button>
              <button onClick={() => handleExport('xlsx', 'customers')} className="text-left px-4 py-2.5 text-xs font-medium text-stone-700 hover:bg-amber-50 transition-colors cursor-pointer">Top Customers → Excel</button>
            </div>
          </div>
          )}
        </div>
      </div>

      <div className="p-6 space-y-8">
        {/* ===== KPI Cards ===== */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-emerald-600 mb-2">
              <DollarSign className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Net Revenue</p>
            </div>
            <p className="font-mono text-2xl font-bold text-stone-900">{fmtNum(kpi.netRevenue)} ETB</p>
            <p className="text-[10px] text-stone-400 mt-1">Gross: {fmtNum(kpi.grossRevenue)} ETB</p>
          </div>

          <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-blue-600 mb-2">
              <ShoppingBag className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Total Orders</p>
            </div>
            <p className="font-mono text-2xl font-bold text-stone-900">{kpi.ordersCount}</p>
            <p className="text-xs font-bold text-stone-400 mt-1">{kpi.successful} successful · {kpi.failedCount} failed</p>
          </div>

          <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-amber-600 mb-2">
              <TrendingUp className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Avg Order Value</p>
            </div>
            <p className="font-mono text-2xl font-bold text-stone-900">{fmtNum(kpi.avgOrderValue)} ETB</p>
            <p className="text-[10px] text-stone-400 mt-1">{kpi.itemsSold} items sold in period</p>
          </div>

          <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-indigo-600 mb-2">
              <Banknote className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Chapa Revenue</p>
            </div>
            <p className="font-mono text-2xl font-bold text-indigo-900">{fmtNum(kpi.chapaRevenue)} ETB</p>
            <p className="text-[10px] text-indigo-400 mt-1">{chapaShare.toFixed(0)}% of paid sales</p>
          </div>

          <div className="bg-teal-50 border border-teal-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-teal-600 mb-2">
              <CreditCard className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Cash Revenue</p>
            </div>
            <p className="font-mono text-2xl font-bold text-teal-900">{fmtNum(kpi.cashRevenue)} ETB</p>
            <p className="text-[10px] text-teal-400 mt-1">Cash on Delivery</p>
          </div>

          <div className="bg-violet-50 border border-violet-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-violet-600 mb-2">
              <Users className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Unique Customers</p>
            </div>
            <p className="font-mono text-2xl font-bold text-violet-900">{kpi.uniqueCustomers}</p>
            <p className="text-[10px] text-violet-400 mt-1 flex items-center"><Repeat className="w-3 h-3 mr-1" />{kpi.repeatCustomers} repeat buyers</p>
          </div>

          <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-amber-600 mb-2">
              <Clock className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Avg Prep Time</p>
            </div>
            <p className="font-mono text-2xl font-bold text-amber-900">
              {prepStats.sampleCount > 0 ? `${Math.round(prepStats.avgPrep)} min` : 'N/A'}
            </p>
            <p className="text-[10px] text-amber-400 mt-1">{prepStats.sampleCount} fulfilled orders tracked</p>
          </div>
        </div>

        {/* ===== Charts row 1 ===== */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-2 border border-stone-100 rounded-xl p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-4 flex items-center">
              <Activity className="w-3.5 h-3.5 mr-2" />
              Revenue &amp; Order Trends
            </h3>
            <div className="h-64 w-full">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#6B7280' }} dy={10} />
                    <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#6B7280', fontFamily: 'monospace' }} width={60} />
                    <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#6B7280', fontFamily: 'monospace' }} width={40} />
                    <Tooltip cursor={{ fill: '#F3F4F6' }} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                    <Bar yAxisId="left" dataKey="Revenue" fill="#059669" radius={[4, 4, 0, 0]} name="Net Revenue (ETB)" />
                    <Line yAxisId="right" type="monotone" dataKey="Orders" stroke="#D97706" strokeWidth={2} name="Order Count" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-stone-400 text-xs">No trend data available for this range.</div>
              )}
            </div>
          </div>

          <div className="border border-stone-100 rounded-xl p-5 flex flex-col">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-4 flex items-center">
              <BadgePercent className="w-3.5 h-3.5 mr-2" />
              Sales by Category
            </h3>
            <div className="flex-1 min-h-[250px]">
              {categoryData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={categoryData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                      {categoryData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => [`${fmtNum(value)} ETB`, 'Revenue']} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Legend layout="vertical" verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: '10px' }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-stone-400 text-xs">No category data available.</div>
              )}
            </div>
          </div>
        </div>

        {/* ===== Charts row 2: hourly, weekday, payment, status ===== */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="border border-stone-100 rounded-xl p-4 lg:col-span-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-3 flex items-center">
              <Clock className="w-3.5 h-3.5 mr-2" />
              Sales by Hour of Day
            </h3>
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                  <XAxis dataKey="hour" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#6B7280' }} interval={2} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#6B7280', fontFamily: 'monospace' }} width={50} />
                  <Tooltip cursor={{ fill: '#F3F4F6' }} contentStyle={{ borderRadius: '8px', border: 'none' }} />
                  <Bar dataKey="revenue" fill="#2563EB" radius={[3, 3, 0, 0]} name="Revenue (ETB)" />
                  <Bar dataKey="orders" fill="#D97706" radius={[3, 3, 0, 0]} name="Orders" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="border border-stone-100 rounded-xl p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-3 flex items-center">
              <Repeat className="w-3.5 h-3.5 mr-2" />
              Day of Week
            </h3>
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weekdayData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#6B7280' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#6B7280' }} width={40} />
                  <Tooltip cursor={{ fill: '#F3F4F6' }} contentStyle={{ borderRadius: '8px', border: 'none' }} />
                  <Bar dataKey="revenue" fill="#7C3AED" radius={[3, 3, 0, 0]} name="Revenue (ETB)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="border border-stone-100 rounded-xl p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-3 flex items-center">
              <Banknote className="w-3.5 h-3.5 mr-2" />
              Payment Method
            </h3>
            {paymentMethodData.length > 0 ? (
              <div className="h-40 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={paymentMethodData} cx="50%" cy="50%" innerRadius={32} outerRadius={55} paddingAngle={4} dataKey="value">
                      {paymentMethodData.map((e, i) => <Cell key={i} fill={e.key === 'chapa' ? '#059669' : '#D97706'} />)}
                    </Pie>
                    <Tooltip formatter={(value: number) => [`${fmtNum(value)} ETB`]} contentStyle={{ borderRadius: '8px', border: 'none' }} />
                    <Legend wrapperStyle={{ fontSize: '9px' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-40 flex items-center justify-center text-stone-400 text-xs">No paid orders.</div>
            )}
          </div>
        </div>

        {/* ===== Daily Transaction Sheet ===== */}
        <div className="border border-stone-100 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-stone-100 bg-stone-50 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-700 flex items-center">
              <Table2 className="w-3.5 h-3.5 mr-2 text-amber-600" />
              Daily Transaction Sheet
              {selectedDay && (
                <button
                  onClick={() => setSelectedDay(null)}
                  className="ml-3 text-[10px] font-bold text-rose-600 hover:underline cursor-pointer"
                >
                  ✕ Clear day filter ({format(parseISO(selectedDay), 'MMM d')})
                </button>
              )}
            </h3>
            <div className="flex items-center gap-2">
              {canExport && (
                <>
                  <button onClick={() => handleExport('csv', 'daily')} className="text-[10px] font-bold text-stone-600 border border-stone-300 rounded px-2 py-1 hover:bg-stone-100 transition-colors cursor-pointer">CSV</button>
                  <button onClick={() => handleExport('xlsx', 'daily')} className="text-[10px] font-bold text-emerald-700 border border-emerald-200 bg-emerald-50 rounded px-2 py-1 hover:bg-emerald-100 transition-colors cursor-pointer">Excel</button>
                  <button onClick={() => handleExport('xlsx', 'transactions')} className="text-[10px] font-bold text-stone-600 border border-stone-300 rounded px-2 py-1 hover:bg-stone-100 transition-colors cursor-pointer">Full Log</button>
                </>
              )}
            </div>
          </div>
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-white border-b border-stone-100 shadow-xs">
                  <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Date</th>
                  <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Orders</th>
                  <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Items</th>
                  <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Net Revenue</th>
                  <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Chapa</th>
                  <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Cash</th>
                  <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Avg Order</th>
                  <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Act.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 bg-white">
                {dailyRows.length > 0 ? dailyRows.map((row, idx) => (
                  <tr
                    key={row.date}
                    className={`transition-colors ${selectedDay === row.date ? 'bg-amber-50' : 'hover:bg-stone-50/50'}`}
                  >
                    <td className="py-2.5 px-4 text-xs font-bold text-stone-900">{row.label}</td>
                    <td className="py-2.5 px-4 text-xs text-stone-700 text-right font-mono">{row.orders}</td>
                    <td className="py-2.5 px-4 text-xs text-stone-600 text-right font-mono">{row.items}</td>
                    <td className="py-2.5 px-4 text-xs font-mono font-medium text-emerald-600 text-right">{fmtNum(row.netRevenue)}</td>
                    <td className="py-2.5 px-4 text-xs font-mono text-indigo-600 text-right">{fmtNum(row.chapa)}</td>
                    <td className="py-2.5 px-4 text-xs font-mono text-teal-600 text-right">{fmtNum(row.cash)}</td>
                    <td className="py-2.5 px-4 text-xs font-mono text-stone-500 text-right">{fmtNum(row.avgOrder)}</td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        onClick={() => setSelectedDay(selectedDay === row.date ? null : row.date)}
                        className="text-[10px] font-bold text-amber-700 bg-amber-100 rounded px-2 py-1 hover:bg-amber-200 transition-colors cursor-pointer"
                      >
                        {selectedDay === row.date ? 'Close' : 'Orders'}
                      </button>
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={8} className="py-6 px-4 text-center text-xs text-stone-400">No transactions in this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* drill-down: orders for the selected day */}
          {selectedDay && (
            <div className="border-t border-stone-100 bg-amber-50/40">
              <div className="px-4 py-3 flex items-center justify-between">
                <p className="text-xs font-bold text-stone-700 uppercase tracking-wide">
                  Orders — {format(parseISO(selectedDay), 'MMMM d, yyyy')}
                </p>
                {canExport && (
                  <button
                    onClick={() => handleExport('csv', 'transactions')}
                    className="text-[10px] font-bold text-amber-700 border border-amber-200 bg-white rounded px-2 py-1 hover:bg-amber-100 transition-colors cursor-pointer"
                  >
                    Export this day's orders
                  </button>
                )}
              </div>
              <div className="overflow-x-auto max-h-[360px] overflow-y-auto border-t border-amber-100">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-white border-b border-stone-100">
                      <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Time / Order</th>
                      <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Customer</th>
                      <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Items</th>
                      <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Method</th>
                      <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Total</th>
                      <th className="py-2.5 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 bg-white">
                    {(rangeOrders || [])
                      .filter(o => {
                        const d = parseOrderDate(o);
                        return d ? format(d, 'yyyy-MM-dd') === selectedDay : false;
                      })
                      .sort((a, b) => (parseOrderDate(a)?.getTime() || 0) - (parseOrderDate(b)?.getTime() || 0))
                      .map(order => {
                        const d = parseOrderDate(order);
                        const sum = itemsSummary(order);
                        const refundLike = isRefundedLike(order);
                        return (
                          <tr key={order.id} className="hover:bg-stone-50/60">
                            <td className="py-2.5 px-4">
                              <div className="text-xs font-mono font-medium text-stone-900">{d ? format(d, 'HH:mm') : '--'}</div>
                              <div className="text-[9px] font-mono text-stone-400">#{order.id.slice(-6)}</div>
                            </td>
                            <td className="py-2.5 px-4 text-xs text-stone-700">{order.customerName || 'Guest'}</td>
                            <td className="py-2.5 px-4 text-xs text-stone-600 max-w-[260px] truncate">{sum.text || '—'}</td>
                            <td className="py-2.5 px-4 text-xs font-bold uppercase text-stone-500">
                              {order.paymentMethod === 'chapa' ? 'Chapa' : 'Cash'}
                            </td>
                            <td className={`py-2.5 px-4 text-right text-xs font-mono font-bold ${refundLike ? 'text-rose-600' : 'text-emerald-600'}`}>
                              {fmtNum(order.total || 0)} ETB
                            </td>
                            <td className="py-2.5 px-4">
                              <span className={`text-[9px] uppercase font-bold px-2 py-0.5 rounded-full border ${refundLike ? 'bg-rose-50 text-rose-600 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                                {refundLike ? (order.paymentStatus === 'failed' ? 'Failed' : 'Cancelled') : order.status}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ===== Tables row ===== */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="border border-stone-100 rounded-xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-stone-100 bg-stone-50 flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-stone-700 flex items-center">
                <TrendingUp className="w-3.5 h-3.5 mr-2 text-emerald-600" />
                Top Performing Items
              </h3>
              {canExport && <button onClick={() => handleExport('xlsx', 'items')} className="text-[10px] font-bold text-stone-500 hover:text-emerald-700 border border-stone-200 rounded px-2 py-1 transition-colors cursor-pointer">Export</button>}
            </div>
            <div className="p-0 overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-white border-b border-stone-100">
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Item Name</th>
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Units Sold</th>
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 bg-white">
                  {topItems.length > 0 ? topItems.map((item, idx) => (
                    <tr key={idx} className="hover:bg-stone-50/50 transition-colors">
                      <td className="py-3 px-4 text-xs font-bold text-stone-900">{item.name}</td>
                      <td className="py-3 px-4 text-xs text-stone-600 text-right">{item.quantity}</td>
                      <td className="py-3 px-4 text-xs font-mono font-medium text-emerald-600 text-right">{fmtNum(item.revenue)} ETB</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={3} className="py-6 px-4 text-center text-xs text-stone-400">No items sold in this period.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border border-stone-100 rounded-xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-stone-100 bg-stone-50 flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-stone-700 flex items-center">
                <Users className="w-3.5 h-3.5 mr-2 text-violet-600" />
                Top Customers
              </h3>
              {canExport && <button onClick={() => handleExport('xlsx', 'customers')} className="text-[10px] font-bold text-stone-500 hover:text-violet-700 border border-stone-200 rounded px-2 py-1 transition-colors cursor-pointer">Export</button>}
            </div>
            <div className="p-0 overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-white border-b border-stone-100">
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Customer</th>
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Orders</th>
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Revenue</th>
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Avg Order</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 bg-white">
                  {topCustomers.length > 0 ? topCustomers.map((c, idx) => (
                    <tr key={idx} className="hover:bg-stone-50/50 transition-colors">
                      <td className="py-3 px-4">
                        <div className="text-xs font-bold text-stone-900">{c.name}</div>
                        <div className="text-[10px] text-stone-400 truncate max-w-[140px]">{c.email || c.phone || 'no contact'}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-stone-600 text-right">{c.orders} {c.orders > 1 && '★'}</td>
                      <td className="py-3 px-4 text-xs font-mono font-medium text-emerald-600 text-right">{fmtNum(c.revenue)} ETB</td>
                      <td className="py-3 px-4 text-xs font-mono text-stone-500 text-right">{fmtNum(c.avgOrder)}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={4} className="py-6 px-4 text-center text-xs text-stone-400">No customer data in this period.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border border-stone-100 rounded-xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-stone-100 bg-indigo-50/40 flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-900 flex items-center">
                <Clock className="w-3.5 h-3.5 mr-2 text-indigo-600" />
                Fulfillment Time (Place → Ready)
              </h3>
              <span className="text-[10px] font-bold text-indigo-500">{prepStats.sampleCount} orders tracked</span>
            </div>
            <div className="p-4">
              {fulfillmentData.length > 0 ? (
                <div className="h-40 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={fulfillmentData} layout="vertical" margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#E5E7EB" />
                      <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#6B7280' }} />
                      <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#6B7280' }} width={70} />
                      <Tooltip cursor={{ fill: '#F3F4F6' }} contentStyle={{ borderRadius: '8px', border: 'none' }} />
                      <Bar dataKey="count" fill="#2563EB" radius={[0, 4, 4, 0]} name="Orders" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-40 flex items-center justify-center text-stone-400 text-xs">
                  Track order status changes to see prep times.<br />Available once orders are marked Ready/Delivered.
                </div>
              )}
            </div>
            <div className="px-4 pb-4 pt-1">
              <p className="text-[9px] uppercase tracking-wider text-stone-400 font-bold mb-2">Order Status Mix</p>
              <div className="flex flex-wrap gap-1.5">
                {statusData.length > 0 ? statusData.map((s, i) => (
                  <span key={i} className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-1 rounded-full border" style={{ backgroundColor: `${COLORS[i % COLORS.length]}14`, borderColor: `${COLORS[i % COLORS.length]}33`, color: COLORS[i % COLORS.length] }}>
                    {s.name}: {s.count}
                  </span>
                )) : <span className="text-[10px] text-stone-400">No status data</span>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
