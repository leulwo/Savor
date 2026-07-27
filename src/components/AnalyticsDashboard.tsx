import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, onSnapshot, orderBy } from 'firebase/firestore';
import { Order } from '../types';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, PieChart, Pie, Cell } from 'recharts';
import { TrendingUp, DollarSign, ShoppingBag, Activity, Calendar, Filter, ArrowUpRight, ArrowDownRight, AlertCircle, RefreshCw } from 'lucide-react';
import { format, subDays, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, isWithinInterval, parseISO, isSameDay, isSameWeek, isSameMonth, isSameYear } from 'date-fns';

type TimeRange = 'daily' | 'weekly' | 'monthly' | 'yearly';

const COLORS = ['#D97706', '#059669', '#2563EB', '#DC2626', '#7C3AED', '#DB2777', '#0891B2'];

export default function AnalyticsDashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<TimeRange>('daily');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

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
          item.menuItem.categories.forEach(c => {
            if (c) categories.add(c);
          });
        } else if (item.menuItem.category) {
          categories.add(item.menuItem.category);
        }
      });
    });
    return Array.from(categories);
  }, [orders]);

  const filteredOrders = useMemo(() => {
    let filtered = orders || [];
    const now = new Date();

    if (selectedCategory !== 'all') {
      filtered = filtered.filter(order => 
        (order?.items || []).some(item => 
          (Array.isArray(item?.menuItem?.categories) && item.menuItem.categories.includes(selectedCategory)) || 
          item?.menuItem?.category === selectedCategory
        )
      );
    }
    return filtered;
  }, [orders, selectedCategory]);

  const { totalRevenue, totalOrders, totalRefunds, totalRefundAmount, successfulOrders, chartData, categoryData, topItems, recentRefunds } = useMemo(() => {
    let revenue = 0;
    let ordersCount = 0;
    let refunds = 0;
    let refundAmount = 0;
    let successful = 0;
    
    const chartMap = new Map<string, any>();
    const categoryMap = new Map<string, number>();
    const itemsMap = new Map<string, { name: string, quantity: number, revenue: number }>();
    const refundsList: any[] = [];

    const now = new Date();

    (filteredOrders || []).forEach(order => {
      if (!order || !order.createdAt) return;
      let orderDate: Date;
      try {
        orderDate = parseISO(order.createdAt);
        if (isNaN(orderDate.getTime())) {
          orderDate = new Date(order.createdAt);
        }
      } catch (e) {
        orderDate = new Date();
      }
      if (isNaN(orderDate.getTime())) return;

      let dateKey = '';
      
      if (timeRange === 'daily') {
        if (orderDate >= subDays(now, 30)) { // limit to last 30 days
          dateKey = format(orderDate, 'MMM dd');
        }
      } else if (timeRange === 'weekly') {
        if (orderDate >= subDays(now, 90)) {
          dateKey = `Week of ${format(startOfWeek(orderDate), 'MMM dd')}`;
        }
      } else if (timeRange === 'monthly') {
        if (orderDate >= startOfYear(now)) {
          dateKey = format(orderDate, 'MMM yyyy');
        }
      } else if (timeRange === 'yearly') {
        dateKey = format(orderDate, 'yyyy');
      }

      if (dateKey) {
        if (!chartMap.has(dateKey)) {
          chartMap.set(dateKey, { dateKey, Revenue: 0, Orders: 0, Refunds: 0, RefundAmount: 0 });
        }
        const data = chartMap.get(dateKey)!;

        ordersCount++;
        data.Orders++;

        const totalAmount = typeof order.total === 'number' ? order.total : 0;

        if (order.status === 'cancelled' || order.paymentStatus === 'refunded' || order.paymentStatus === 'failed') {
          refunds++;
          refundAmount += totalAmount;
          data.Refunds++;
          data.RefundAmount += totalAmount;
          refundsList.push({
            id: order.id || 'N/A',
            date: format(orderDate, 'MMM dd, yyyy HH:mm'),
            amount: totalAmount,
            reason: order.status === 'cancelled' ? 'Cancelled' : 'Refunded/Failed',
            customer: order.customerName || 'Guest'
          });
        } else {
          revenue += totalAmount;
          successful++;
          data.Revenue += totalAmount;
          
          (order.items || []).forEach(item => {
            if (!item) return;
            const itemPrice = item.menuItem?.price || 0;
            const itemQty = item.quantity || 1;
            const cat = item.menuItem?.category || 'uncategorized';
            categoryMap.set(cat, (categoryMap.get(cat) || 0) + (itemQty * itemPrice));
            
            const itemId = item.menuItem?.id || item.menuItemId || 'unknown';
            const itemName = item.menuItem?.name || 'Dish';
            if (!itemsMap.has(itemId)) {
              itemsMap.set(itemId, { name: itemName, quantity: 0, revenue: 0 });
            }
            const itemData = itemsMap.get(itemId)!;
            itemData.quantity += itemQty;
            itemData.revenue += (itemQty * itemPrice);
          });
        }
      }
    });

    const categoryArray = Array.from(categoryMap.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    const topItemsArray = Array.from(itemsMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    refundsList.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      totalRevenue: revenue,
      totalOrders: ordersCount,
      totalRefunds: refunds,
      totalRefundAmount: refundAmount,
      successfulOrders: successful,
      chartData: Array.from(chartMap.values()),
      categoryData: categoryArray,
      topItems: topItemsArray,
      recentRefunds: refundsList.slice(0, 5)
    };
  }, [filteredOrders, timeRange]);

  if (loading) {
    return <div className="p-12 text-center text-stone-500 flex flex-col items-center"><RefreshCw className="w-8 h-8 animate-spin mb-4" />Loading analytics...</div>;
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden font-sans">
      <div className="p-5 border-b border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between bg-stone-50 gap-4">
        <div className="flex items-center space-x-3">
          <div className="bg-amber-100 p-2 rounded-lg text-amber-700">
            <Activity className="w-5 h-5" />
          </div>
          <h2 className="font-serif text-lg font-bold text-stone-900">Analytics Overview</h2>
        </div>
        
        <div className="flex items-center gap-3">
          <select 
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="text-xs border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-amber-500 outline-none"
          >
            <option value="all">All Categories</option>
            {(allCategories || []).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select 
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            className="text-xs border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-amber-500 outline-none"
          >
            <option value="daily">Daily (Last 30 Days)</option>
            <option value="weekly">Weekly (Last 90 Days)</option>
            <option value="monthly">Monthly (This Year)</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
      </div>

      <div className="p-6 space-y-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-emerald-600 mb-2">
              <DollarSign className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Net Revenue</p>
            </div>
            <p className="font-mono text-2xl font-bold text-stone-900">{totalRevenue.toFixed(2)} ETB</p>
          </div>
          
          <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-blue-600 mb-2">
              <ShoppingBag className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Total Orders</p>
            </div>
            <p className="font-mono text-2xl font-bold text-stone-900">{totalOrders}</p>
            <p className="text-xs font-bold text-stone-400 mt-1">{successfulOrders} Successful</p>
          </div>

          <div className="bg-rose-50 border border-rose-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-rose-600 mb-2">
              <AlertCircle className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Refunds/Cancellations</p>
            </div>
            <p className="font-mono text-2xl font-bold text-rose-900">{totalRefunds}</p>
            <p className="text-xs font-bold text-rose-500 mt-1">{totalRefundAmount.toFixed(2)} ETB Lost</p>
          </div>

          <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
            <div className="flex items-center space-x-2 text-amber-600 mb-2">
              <TrendingUp className="w-4 h-4" />
              <p className="text-[10px] uppercase font-bold tracking-wider">Avg Order Value</p>
            </div>
            <p className="font-mono text-2xl font-bold text-stone-900">
              {successfulOrders > 0 ? (totalRevenue / successfulOrders).toFixed(2) : '0.00'} ETB
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-2 border border-stone-100 rounded-xl p-5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-4 flex items-center">
              <Activity className="w-3.5 h-3.5 mr-2" />
              Revenue & Order Trends
            </h3>
            <div className="h-64 w-full">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                    <XAxis 
                      dataKey="dateKey" 
                      axisLine={false} 
                      tickLine={false} 
                      tick={{ fontSize: 10, fill: '#6B7280' }} 
                      dy={10}
                    />
                    <YAxis 
                      yAxisId="left"
                      axisLine={false} 
                      tickLine={false} 
                      tick={{ fontSize: 10, fill: '#6B7280', fontFamily: 'monospace' }} 
                      width={60}
                    />
                    <YAxis 
                      yAxisId="right"
                      orientation="right"
                      axisLine={false} 
                      tickLine={false} 
                      tick={{ fontSize: 10, fill: '#6B7280', fontFamily: 'monospace' }} 
                      width={40}
                    />
                    <Tooltip 
                      cursor={{ fill: '#F3F4F6' }}
                      contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                    <Bar yAxisId="left" dataKey="Revenue" fill="#059669" radius={[4, 4, 0, 0]} name="Revenue (ETB)" />
                    <Bar yAxisId="left" dataKey="RefundAmount" fill="#DC2626" radius={[4, 4, 0, 0]} name="Refunds (ETB)" />
                    <Line yAxisId="right" type="monotone" dataKey="Orders" stroke="#D97706" strokeWidth={2} name="Order Count" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-stone-400 text-xs">
                  No trend data available for this range.
                </div>
              )}
            </div>
          </div>

          <div className="border border-stone-100 rounded-xl p-5 flex flex-col">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-4 flex items-center">
              <PieChart className="w-3.5 h-3.5 mr-2" />
              Sales by Category
            </h3>
            <div className="flex-1 min-h-[250px]">
              {categoryData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={categoryData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {categoryData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => [`${value.toFixed(2)} ETB`, 'Revenue']}
                      contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    />
                    <Legend 
                      layout="vertical" 
                      verticalAlign="bottom" 
                      align="center"
                      wrapperStyle={{ fontSize: '10px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-stone-400 text-xs">
                  No category data available.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Tables Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="border border-stone-100 rounded-xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-stone-100 bg-stone-50">
              <h3 className="text-xs font-bold uppercase tracking-wider text-stone-700 flex items-center">
                <TrendingUp className="w-3.5 h-3.5 mr-2 text-emerald-600" />
                Top Performing Items
              </h3>
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
                  {topItems.length > 0 ? (
                    topItems.map((item, idx) => (
                      <tr key={idx} className="hover:bg-stone-50/50 transition-colors">
                        <td className="py-3 px-4 text-xs font-bold text-stone-900">{item.name}</td>
                        <td className="py-3 px-4 text-xs text-stone-600 text-right">{item.quantity}</td>
                        <td className="py-3 px-4 text-xs font-mono font-medium text-emerald-600 text-right">{item.revenue.toFixed(2)} ETB</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="py-6 px-4 text-center text-xs text-stone-400">No items sold in this period.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border border-stone-100 rounded-xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-stone-100 bg-rose-50/50">
              <h3 className="text-xs font-bold uppercase tracking-wider text-rose-800 flex items-center">
                <AlertCircle className="w-3.5 h-3.5 mr-2 text-rose-600" />
                Recent Refunds & Cancellations
              </h3>
            </div>
            <div className="p-0 overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-white border-b border-stone-100">
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Order / Date</th>
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider">Customer</th>
                    <th className="py-3 px-4 text-[10px] font-bold text-stone-500 uppercase tracking-wider text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 bg-white">
                  {recentRefunds.length > 0 ? (
                    recentRefunds.map((refund, idx) => (
                      <tr key={idx} className="hover:bg-rose-50/30 transition-colors">
                        <td className="py-3 px-4">
                          <div className="text-xs font-mono font-medium text-stone-900">#{refund.id.slice(-6)}</div>
                          <div className="text-[10px] text-stone-500">{refund.date}</div>
                        </td>
                        <td className="py-3 px-4 text-xs text-stone-600">
                          <div>{refund.customer}</div>
                          <div className="text-[9px] font-bold text-rose-600 uppercase mt-0.5">{refund.reason}</div>
                        </td>
                        <td className="py-3 px-4 text-xs font-mono font-medium text-rose-600 text-right">
                          {refund.amount.toFixed(2)} ETB
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="py-6 px-4 text-center text-xs text-stone-400">No refunds or cancellations in this period.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

