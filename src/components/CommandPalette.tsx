/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  Search, ShoppingBag, Utensils, Users, LayoutDashboard, Settings, 
  History, CalendarDays, ChefHat, Percent, MessageSquare, ArrowRight, X, Sparkles
} from "lucide-react";
import { Order, MenuItem, UserProfile } from "../types";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (tab: string, payload?: any) => void;
  orders?: Order[];
  menu?: MenuItem[];
  customers?: UserProfile[];
}

export default function CommandPalette({
  isOpen,
  onClose,
  onNavigate,
  orders = [],
  menu = [],
  customers = []
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Global shortcut listener for Cmd+K / Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (isOpen) {
          onClose();
        } else {
          // Open palette
          (window as any).__openCommandPalette?.();
        }
      }
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const quickNavItems = [
    { label: "Dashboard Overview", tab: "overview", icon: LayoutDashboard, category: "Navigation" },
    { label: "Orders Management", tab: "orders", icon: ShoppingBag, category: "Navigation" },
    { label: "Menu & Categories", tab: "menu", icon: Utensils, category: "Navigation" },
    { label: "Kitchen Display (KDS)", tab: "kds", icon: ChefHat, category: "Navigation" },
    { label: "Customer Profiles", tab: "customers", icon: Users, category: "Navigation" },
    { label: "Executive Reports", tab: "reports", icon: Sparkles, category: "Navigation" },
    { label: "Live Customer Inbox", tab: "chat", icon: MessageSquare, category: "Navigation" },
    { label: "Table Reservations", tab: "reservations", icon: CalendarDays, category: "Navigation" },
    { label: "Marketing & Promos", tab: "marketing", icon: Percent, category: "Navigation" },
    { label: "System Activity Audit Log", tab: "audit", icon: History, category: "Navigation" },
    { label: "Global Settings", tab: "settings", icon: Settings, category: "Navigation" },
  ];

  // Search matches
  const q = query.toLowerCase().trim();

  const matchingNav = !q 
    ? quickNavItems.slice(0, 5) 
    : quickNavItems.filter(n => n.label.toLowerCase().includes(q));

  const matchingOrders = !q 
    ? [] 
    : orders.filter(o => 
        (o.id && o.id.toLowerCase().includes(q)) ||
        (o.customerName && o.customerName.toLowerCase().includes(q)) ||
        (o.customerEmail && o.customerEmail.toLowerCase().includes(q))
      ).slice(0, 4);

  const matchingMenu = !q 
    ? [] 
    : menu.filter(m => 
        (m.name && m.name.toLowerCase().includes(q)) ||
        (m.category && m.category.toLowerCase().includes(q)) ||
        (m.description && m.description.toLowerCase().includes(q))
      ).slice(0, 4);

  const matchingCustomers = !q 
    ? [] 
    : customers.filter(c => 
        (c.displayName && c.displayName.toLowerCase().includes(q)) ||
        (c.email && c.email.toLowerCase().includes(q))
      ).slice(0, 4);

  // Flattened results for keyboard navigation
  const results = [
    ...matchingNav.map(n => ({ type: 'nav' as const, data: n })),
    ...matchingOrders.map(o => ({ type: 'order' as const, data: o })),
    ...matchingMenu.map(m => ({ type: 'menu' as const, data: m })),
    ...matchingCustomers.map(c => ({ type: 'customer' as const, data: c })),
  ];

  const handleSelect = (index: number) => {
    const item = results[index];
    if (!item) return;

    if (item.type === 'nav') {
      onNavigate(item.data.tab);
    } else if (item.type === 'order') {
      onNavigate('orders', item.data);
    } else if (item.type === 'menu') {
      onNavigate('menu', item.data);
    } else if (item.type === 'customer') {
      onNavigate('customers', item.data);
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(1, results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + results.length) % Math.max(1, results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSelect(selectedIndex);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-start justify-center pt-20 px-4">
      <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl border border-stone-200 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Search Input Bar */}
        <div className="p-4 border-b border-stone-100 flex items-center space-x-3 bg-stone-50/50">
          <Search className="w-5 h-5 text-stone-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search orders, menu dishes, customers, or jump to page... (Esc to close)"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            className="w-full text-sm bg-transparent focus:outline-none text-stone-900 placeholder:text-stone-400 font-medium"
          />
          <kbd className="hidden sm:inline-block px-2 py-0.5 text-[10px] font-mono bg-stone-200 text-stone-600 rounded">
            ESC
          </kbd>
        </div>

        {/* Results Container */}
        <div className="p-3 max-h-96 overflow-y-auto space-y-4">
          {/* Navigation Matches */}
          {matchingNav.length > 0 && (
            <div>
              <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-400">Navigation</p>
              <div className="space-y-1">
                {matchingNav.map((nav, idx) => {
                  const itemIndex = idx;
                  const isSelected = selectedIndex === itemIndex;
                  const Icon = nav.icon;
                  return (
                    <div
                      key={nav.tab}
                      onClick={() => handleSelect(itemIndex)}
                      className={`px-3 py-2.5 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-colors ${
                        isSelected ? 'bg-amber-500 text-stone-950 font-bold shadow-xs' : 'hover:bg-stone-50 text-stone-700'
                      }`}
                    >
                      <div className="flex items-center space-x-2.5">
                        <Icon className="w-4 h-4 shrink-0" />
                        <span>{nav.label}</span>
                      </div>
                      <ArrowRight className="w-3.5 h-3.5 opacity-60" />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Order Matches */}
          {matchingOrders.length > 0 && (
            <div>
              <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-400">Orders</p>
              <div className="space-y-1">
                {matchingOrders.map((order, idx) => {
                  const itemIndex = matchingNav.length + idx;
                  const isSelected = selectedIndex === itemIndex;
                  return (
                    <div
                      key={order.id}
                      onClick={() => handleSelect(itemIndex)}
                      className={`px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-colors ${
                        isSelected ? 'bg-amber-500 text-stone-950 font-bold shadow-xs' : 'hover:bg-stone-50 text-stone-700'
                      }`}
                    >
                      <div className="flex items-center space-x-2.5">
                        <ShoppingBag className="w-4 h-4 shrink-0" />
                        <div>
                          <span className="font-mono font-bold">#{order.id}</span>
                          <span className="ml-2 font-normal opacity-80">{order.customerName || 'Guest'}</span>
                        </div>
                      </div>
                      <span className="font-mono text-[11px] font-bold">{order.total?.toFixed(2)} ETB</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Menu Item Matches */}
          {matchingMenu.length > 0 && (
            <div>
              <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-400">Menu Items</p>
              <div className="space-y-1">
                {matchingMenu.map((item, idx) => {
                  const itemIndex = matchingNav.length + matchingOrders.length + idx;
                  const isSelected = selectedIndex === itemIndex;
                  return (
                    <div
                      key={item.id}
                      onClick={() => handleSelect(itemIndex)}
                      className={`px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-colors ${
                        isSelected ? 'bg-amber-500 text-stone-950 font-bold shadow-xs' : 'hover:bg-stone-50 text-stone-700'
                      }`}
                    >
                      <div className="flex items-center space-x-2.5">
                        <Utensils className="w-4 h-4 shrink-0" />
                        <div>
                          <span className="font-bold">{item.name}</span>
                          <span className="ml-2 text-[10px] opacity-70 font-mono">[{item.category}]</span>
                        </div>
                      </div>
                      <span className="font-mono text-[11px] font-bold">{item.price?.toFixed(2)} ETB</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Customer Matches */}
          {matchingCustomers.length > 0 && (
            <div>
              <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-400">Customers</p>
              <div className="space-y-1">
                {matchingCustomers.map((cust, idx) => {
                  const itemIndex = matchingNav.length + matchingOrders.length + matchingMenu.length + idx;
                  const isSelected = selectedIndex === itemIndex;
                  return (
                    <div
                      key={cust.uid}
                      onClick={() => handleSelect(itemIndex)}
                      className={`px-3 py-2 rounded-xl text-xs flex items-center justify-between cursor-pointer transition-colors ${
                        isSelected ? 'bg-amber-500 text-stone-950 font-bold shadow-xs' : 'hover:bg-stone-50 text-stone-700'
                      }`}
                    >
                      <div className="flex items-center space-x-2.5">
                        <Users className="w-4 h-4 shrink-0" />
                        <div>
                          <span className="font-bold">{cust.displayName || 'Customer'}</span>
                          <span className="ml-2 text-[10px] opacity-70 font-mono">{cust.email}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {results.length === 0 && (
            <div className="p-8 text-center text-xs text-stone-400">
              No results found for "{query}". Try a different keyword or command.
            </div>
          )}
        </div>

        {/* Footer shortcuts */}
        <div className="p-3 bg-stone-50 border-t border-stone-100 flex items-center justify-between text-[11px] text-stone-400">
          <span>Navigate with <kbd className="font-mono bg-stone-200 px-1 rounded text-stone-700">↑</kbd> <kbd className="font-mono bg-stone-200 px-1 rounded text-stone-700">↓</kbd></span>
          <span>Select with <kbd className="font-mono bg-stone-200 px-1.5 py-0.5 rounded text-stone-700">ENTER</kbd></span>
        </div>
      </div>
    </div>
  );
}
