/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from "react";
import { 
  FileText, Download, Printer, Calendar, TrendingUp, Clock, Users, Utensils, 
  ChevronDown, Filter, AlertCircle, ArrowUpRight, BarChart3
} from "lucide-react";
import { Order, MenuItem } from "../types";
import { downloadXlsx } from "../utils/exportUtils";
import { hasPermission, PermissionMap } from "../permissions";

interface ReportsManagerProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
  orders: Order[];
  menu: MenuItem[];
}

export default function ReportsManager({
  can,
  permissions,
  orders = [],
  menu = []
}: ReportsManagerProps) {
  const canView = can ? can("reports.view") : hasPermission(permissions, "reports.view");

  const [activeReport, setActiveReport] = useState<'sales' | 'peakhours' | 'customers' | 'items'>('sales');
  const [timeRange, setTimeRange] = useState<'7days' | '30days' | '90days' | 'all'>('30days');

  // Filter orders by time range
  const filteredOrders = useMemo(() => {
    if (timeRange === 'all') return orders;
    const now = new Date();
    const days = timeRange === '7days' ? 7 : timeRange === '30days' ? 30 : 90;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return orders.filter(o => new Date(o.createdAt) >= cutoff);
  }, [orders, timeRange]);

  // 1. Daily Sales Summary Data
  const dailySalesData = useMemo(() => {
    const map: Record<string, { date: string; orders: number; revenue: number; tax: number; fees: number }> = {};
    
    filteredOrders.forEach(o => {
      if (o.status === 'cancelled') return;
      const dateKey = new Date(o.createdAt).toLocaleDateString();
      if (!map[dateKey]) {
        map[dateKey] = { date: dateKey, orders: 0, revenue: 0, tax: 0, fees: 0 };
      }
      map[dateKey].orders += 1;
      map[dateKey].revenue += (o.total || 0);
      map[dateKey].tax += (o.serviceTax || 0);
      map[dateKey].fees += (o.flatFee || 0);
    });

    return Object.values(map).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [filteredOrders]);

  // 2. Peak Hours Analysis Data (00:00 to 23:00)
  const peakHoursData = useMemo(() => {
    const hours: { hour: number; label: string; count: number; revenue: number }[] = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      label: `${i.toString().padStart(2, '0')}:00`,
      count: 0,
      revenue: 0
    }));

    filteredOrders.forEach(o => {
      if (o.status === 'cancelled') return;
      try {
        const d = new Date(o.createdAt);
        const h = d.getHours();
        if (hours[h]) {
          hours[h].count += 1;
          hours[h].revenue += (o.total || 0);
        }
      } catch (e) {}
    });

    const maxCount = Math.max(...hours.map(h => h.count), 1);
    return hours.map(h => ({
      ...h,
      percentage: Math.round((h.count / maxCount) * 100)
    }));
  }, [filteredOrders]);

  // 3. Customer Leaderboard Data
  const topCustomersData = useMemo(() => {
    const map: Record<string, { email: string; name: string; totalSpend: number; ordersCount: number; lastOrder: string }> = {};

    filteredOrders.forEach(o => {
      if (o.status === 'cancelled') return;
      const key = o.customerEmail?.toLowerCase() || o.customerName || "Anonymous";
      if (!map[key]) {
        map[key] = {
          email: o.customerEmail || "N/A",
          name: o.customerName || "Customer",
          totalSpend: 0,
          ordersCount: 0,
          lastOrder: o.createdAt
        };
      }
      map[key].totalSpend += (o.total || 0);
      map[key].ordersCount += 1;
      if (new Date(o.createdAt) > new Date(map[key].lastOrder)) {
        map[key].lastOrder = o.createdAt;
      }
    });

    return Object.values(map).sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 50);
  }, [filteredOrders]);

  // 4. Menu Item Performance Data
  const itemPerformanceData = useMemo(() => {
    const map: Record<string, { id: string; name: string; category: string; price: number; unitsSold: number; totalRevenue: number }> = {};

    filteredOrders.forEach(o => {
      if (o.status === 'cancelled') return;
      (o.items || []).forEach(item => {
        const menuItem = item.menuItem || item;
        const id = menuItem.id || menuItem.name;
        if (!map[id]) {
          map[id] = {
            id,
            name: menuItem.name || "Item",
            category: menuItem.category || "General",
            price: menuItem.price || 0,
            unitsSold: 0,
            totalRevenue: 0
          };
        }
        const qty = item.quantity || 1;
        map[id].unitsSold += qty;
        map[id].totalRevenue += qty * (menuItem.price || 0);
      });
    });

    return Object.values(map).sort((a, b) => b.totalRevenue - a.totalRevenue);
  }, [filteredOrders]);

  // Excel Export Handler
  const handleExportExcel = () => {
    if (activeReport === 'sales') {
      const data = dailySalesData.map(r => ({
        "Date": r.date,
        "Completed Orders": r.orders,
        "Total Revenue (ETB)": r.revenue.toFixed(2),
        "Collected Service Tax": r.tax.toFixed(2),
        "Collected Flat Fees": r.fees.toFixed(2)
      }));
      downloadXlsx(`Savory_Sales_Report_${timeRange}.xlsx`, [{ name: "Daily Sales", rows: data }]);
    } else if (activeReport === 'peakhours') {
      const data = peakHoursData.map(h => ({
        "Hour of Day": h.label,
        "Orders Count": h.count,
        "Revenue Generated (ETB)": h.revenue.toFixed(2)
      }));
      downloadXlsx(`Savory_Peak_Hours_Report_${timeRange}.xlsx`, [{ name: "Peak Hours", rows: data }]);
    } else if (activeReport === 'customers') {
      const data = topCustomersData.map((c, idx) => ({
        "Rank": idx + 1,
        "Customer Name": c.name,
        "Email": c.email,
        "Total Spend (ETB)": c.totalSpend.toFixed(2),
        "Orders Placed": c.ordersCount,
        "Last Order Date": new Date(c.lastOrder).toLocaleDateString()
      }));
      downloadXlsx(`Savory_Top_Customers_Report_${timeRange}.xlsx`, [{ name: "Top Customers", rows: data }]);
    } else if (activeReport === 'items') {
      const data = itemPerformanceData.map((i, idx) => ({
        "Rank": idx + 1,
        "Item Name": i.name,
        "Category": i.category,
        "Unit Price (ETB)": i.price.toFixed(2),
        "Units Sold": i.unitsSold,
        "Gross Revenue (ETB)": i.totalRevenue.toFixed(2)
      }));
      downloadXlsx(`Savory_Item_Performance_Report_${timeRange}.xlsx`, [{ name: "Item Performance", rows: data }]);
    }
  };

  // PDF Print Handler
  const handlePrint = () => {
    window.print();
  };

  if (!canView) {
    return (
      <div className="p-8 bg-amber-50/60 border border-amber-200 rounded-2xl text-stone-700 text-center">
        <AlertCircle className="w-8 h-8 text-amber-600 mx-auto mb-2" />
        <h3 className="font-bold text-base text-stone-900">Access Restricted</h3>
        <p className="text-xs text-stone-600 mt-1">You need the "View & export detailed reports" permission to access this module.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 print-report">
      {/* Top Header Card */}
      <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 no-print">
        <div>
          <div className="flex items-center space-x-2">
            <FileText className="w-5 h-5 text-amber-600" />
            <h2 className="text-lg font-bold font-serif text-stone-900">Executive Reports & Data Exports</h2>
          </div>
          <p className="text-xs text-stone-500 mt-0.5">Generate, view, and export detailed operational reports for accounting and analysis</p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Time Range Selector */}
          <select
            value={timeRange}
            onChange={e => setTimeRange(e.target.value as any)}
            className="text-xs bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 text-stone-700 font-bold focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          >
            <option value="7days">Last 7 Days</option>
            <option value="30days">Last 30 Days</option>
            <option value="90days">Last 90 Days</option>
            <option value="all">All Time</option>
          </select>

          <button
            onClick={handleExportExcel}
            className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-all shadow-sm flex items-center space-x-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export to Excel</span>
          </button>

          <button
            onClick={handlePrint}
            className="px-3.5 py-2 bg-stone-900 hover:bg-stone-800 text-white rounded-xl text-xs font-bold transition-all shadow-sm flex items-center space-x-1.5 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print / PDF</span>
          </button>
        </div>
      </div>

      {/* Report Navigation Tabs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 no-print">
        <button
          onClick={() => setActiveReport('sales')}
          className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
            activeReport === 'sales'
              ? 'bg-amber-500 text-stone-950 border-amber-500 shadow-md font-bold'
              : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
          }`}
        >
          <TrendingUp className="w-4 h-4 mb-1" />
          <p className="text-xs font-bold">Daily Sales</p>
          <p className="text-[10px] opacity-80">Revenue & tax breakdown</p>
        </button>

        <button
          onClick={() => setActiveReport('peakhours')}
          className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
            activeReport === 'peakhours'
              ? 'bg-amber-500 text-stone-950 border-amber-500 shadow-md font-bold'
              : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
          }`}
        >
          <Clock className="w-4 h-4 mb-1" />
          <p className="text-xs font-bold">Peak Hours</p>
          <p className="text-[10px] opacity-80">Hourly volume heatmap</p>
        </button>

        <button
          onClick={() => setActiveReport('customers')}
          className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
            activeReport === 'customers'
              ? 'bg-amber-500 text-stone-950 border-amber-500 shadow-md font-bold'
              : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
          }`}
        >
          <Users className="w-4 h-4 mb-1" />
          <p className="text-xs font-bold">Top Customers</p>
          <p className="text-[10px] opacity-80">Lifetime spend & orders</p>
        </button>

        <button
          onClick={() => setActiveReport('items')}
          className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
            activeReport === 'items'
              ? 'bg-amber-500 text-stone-950 border-amber-500 shadow-md font-bold'
              : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
          }`}
        >
          <Utensils className="w-4 h-4 mb-1" />
          <p className="text-xs font-bold">Menu Performance</p>
          <p className="text-[10px] opacity-80">Units sold & gross revenue</p>
        </button>
      </div>

      {/* Active Report Table / Visualizer */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
        {activeReport === 'sales' && (
          <div>
            <div className="p-4 bg-stone-50/50 border-b border-stone-100 flex items-center justify-between">
              <h3 className="font-bold text-xs uppercase tracking-wider text-stone-700">Daily Revenue Ledger ({dailySalesData.length} records)</h3>
              <span className="text-[11px] text-stone-400 font-mono">
                Total Revenue: {dailySalesData.reduce((acc, r) => acc + r.revenue, 0).toLocaleString()} ETB
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-stone-50 text-stone-400 font-bold uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Completed Orders</th>
                    <th className="px-5 py-3">Gross Revenue</th>
                    <th className="px-5 py-3">Service Tax (15%)</th>
                    <th className="px-5 py-3">Flat Fees</th>
                    <th className="px-5 py-3 text-right">Avg Order Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {dailySalesData.map((row, idx) => (
                    <tr key={idx} className="hover:bg-stone-50/50">
                      <td className="px-5 py-3 font-bold text-stone-900">{row.date}</td>
                      <td className="px-5 py-3 font-mono">{row.orders}</td>
                      <td className="px-5 py-3 font-mono font-bold text-stone-900">{row.revenue.toFixed(2)} ETB</td>
                      <td className="px-5 py-3 font-mono text-stone-500">{row.tax.toFixed(2)} ETB</td>
                      <td className="px-5 py-3 font-mono text-stone-500">{row.fees.toFixed(2)} ETB</td>
                      <td className="px-5 py-3 font-mono text-right font-bold text-amber-700">
                        {(row.revenue / (row.orders || 1)).toFixed(2)} ETB
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeReport === 'peakhours' && (
          <div className="p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-stone-100 pb-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-stone-700">Hourly Order Density Heatmap</h3>
              <span className="text-xs text-stone-400">Peak ordering hours over selected period</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
              {peakHoursData.map(hour => (
                <div 
                  key={hour.hour}
                  className={`p-3 rounded-xl border flex flex-col justify-between transition-all ${
                    hour.count > 0 
                      ? 'bg-amber-500/10 border-amber-200' 
                      : 'bg-stone-50 border-stone-100 opacity-60'
                  }`}
                >
                  <div className="flex justify-between items-center text-xs font-bold mb-2">
                    <span className="font-mono text-stone-800">{hour.label}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white text-stone-600 border border-stone-200 font-mono">
                      {hour.count} orders
                    </span>
                  </div>

                  <div className="w-full bg-stone-200 h-1.5 rounded-full overflow-hidden mb-2">
                    <div 
                      className="bg-amber-500 h-full rounded-full transition-all" 
                      style={{ width: `${hour.percentage}%` }}
                    />
                  </div>

                  <p className="text-[10px] font-mono text-stone-500 truncate">
                    {hour.revenue > 0 ? `${hour.revenue.toFixed(0)} ETB` : '—'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeReport === 'customers' && (
          <div>
            <div className="p-4 bg-stone-50/50 border-b border-stone-100 flex items-center justify-between">
              <h3 className="font-bold text-xs uppercase tracking-wider text-stone-700">Top Customers Ranked by Lifetime Value</h3>
              <span className="text-[11px] text-stone-400">Top {topCustomersData.length} records</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-stone-50 text-stone-400 font-bold uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="px-5 py-3">Rank</th>
                    <th className="px-5 py-3">Customer</th>
                    <th className="px-5 py-3">Total Spend</th>
                    <th className="px-5 py-3">Orders</th>
                    <th className="px-5 py-3">Avg Ticket</th>
                    <th className="px-5 py-3 text-right">Last Order</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {topCustomersData.map((c, idx) => (
                    <tr key={idx} className="hover:bg-stone-50/50">
                      <td className="px-5 py-3 font-mono font-bold text-amber-700">#{idx + 1}</td>
                      <td className="px-5 py-3">
                        <p className="font-bold text-stone-900">{c.name}</p>
                        <p className="text-[10px] font-mono text-stone-400">{c.email}</p>
                      </td>
                      <td className="px-5 py-3 font-mono font-bold text-stone-900">{c.totalSpend.toFixed(2)} ETB</td>
                      <td className="px-5 py-3 font-mono">{c.ordersCount}</td>
                      <td className="px-5 py-3 font-mono text-stone-500">
                        {(c.totalSpend / (c.ordersCount || 1)).toFixed(2)} ETB
                      </td>
                      <td className="px-5 py-3 text-right text-stone-400 text-[11px]">
                        {new Date(c.lastOrder).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeReport === 'items' && (
          <div>
            <div className="p-4 bg-stone-50/50 border-b border-stone-100 flex items-center justify-between">
              <h3 className="font-bold text-xs uppercase tracking-wider text-stone-700">Menu Item Sales & Revenue Ranking</h3>
              <span className="text-[11px] text-stone-400">{itemPerformanceData.length} menu items analyzed</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-stone-50 text-stone-400 font-bold uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="px-5 py-3">Rank</th>
                    <th className="px-5 py-3">Dish / Item</th>
                    <th className="px-5 py-3">Category</th>
                    <th className="px-5 py-3">Unit Price</th>
                    <th className="px-5 py-3">Units Sold</th>
                    <th className="px-5 py-3 text-right">Total Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {itemPerformanceData.map((item, idx) => (
                    <tr key={idx} className="hover:bg-stone-50/50">
                      <td className="px-5 py-3 font-mono font-bold text-amber-700">#{idx + 1}</td>
                      <td className="px-5 py-3 font-bold text-stone-900">{item.name}</td>
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-stone-100 text-stone-600 capitalize">
                          {item.category}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-mono">{item.price.toFixed(2)} ETB</td>
                      <td className="px-5 py-3 font-mono font-bold">{item.unitsSold}</td>
                      <td className="px-5 py-3 text-right font-mono font-bold text-emerald-700">
                        {item.totalRevenue.toFixed(2)} ETB
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
