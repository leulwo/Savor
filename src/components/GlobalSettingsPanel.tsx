/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Savory Restaurant
 */

import React, { useState, useEffect } from "react";
import { Settings, Save, AlertCircle, CheckCircle, RotateCcw, Truck, CreditCard, ChevronDown, ChevronUp, Image as ImageIcon, Heart, MessageSquare, CalendarDays, Mail } from "lucide-react";
import { db } from "../firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

export interface GlobalSettings {
  restaurantName?: string;
  logoUrl?: string;
  serviceTaxPercent?: number;
  flatFeeETB?: number;
  enableCOD?: boolean;
  isOpen?: boolean;
  enableMarketing?: boolean;
  enableLoyalty?: boolean;
  enableReservations?: boolean;
  enableChatbot?: boolean;
  [key: string]: any;
}

export default function GlobalSettingsPanel() {
  const [settings, setSettings] = useState<GlobalSettings>({
    restaurantName: "Savory",
    logoUrl: "",
    serviceTaxPercent: 15,
    flatFeeETB: 0,
    enableCOD: true,
    isOpen: true,
    enableMarketing: true,
    enableLoyalty: true,
    enableReservations: true,
    enableChatbot: true
  });
  
  const [loading, setLoading] = useState(false);
  
  // Tab state for categories
  const [activeTab, setActiveTab] = useState<'general' | 'checkout' | 'features' | 'integrations'>('general');
  
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; orderCount?: number } | null>(null);
  const [mailchimpTestResult, setMailchimpTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const docSnap = await getDoc(doc(db, "settings", "global"));
        if (docSnap.exists()) {
          setSettings(prev => ({...prev, ...docSnap.data()}));
        } else {
          // Fallback to legacy checkout settings document if global doesn't exist
          const oldDocSnap = await getDoc(doc(db, "settings", "checkout"));
          if (oldDocSnap.exists()) {
            setSettings(prev => ({...prev, ...oldDocSnap.data()}));
          }
        }
      } catch (e) {
        console.error("Failed to load settings", e);
        setError("Failed to load current settings");
      }
    };
    fetchSettings();
  }, []);

  const handleChange = (field: keyof GlobalSettings, value: any) => {
    setSettings(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const payload = {
        ...settings,
        serviceTaxPercent: parseFloat(settings.serviceTaxPercent?.toString() || "0"),
        flatFeeETB: parseFloat(settings.flatFeeETB?.toString() || "0"),
        updatedAt: new Date().toISOString()
      };
      
      await setDoc(doc(db, "settings", "global"), payload, { merge: true });
      // Duplicate to checkout for backwards compatibility if needed
      await setDoc(doc(db, "settings", "checkout"), payload, { merge: true });
      
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e: any) {
      setError(e.message || "Network error occurred");
    } finally {
      setLoading(false);
    }
  };

  const testMailchimp = async () => {
    setTestLoading(true);
    setMailchimpTestResult(null);
    try {
      const res = await fetch("/api/mailchimp/test");
      const data = await res.json();
      setMailchimpTestResult({ success: data.success, message: data.message || data.error });
    } catch (e) {
      setMailchimpTestResult({ success: false, message: "Network error while testing connection." });
    } finally {
      setTestLoading(false);
    }
  };

  const testShipday = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/shipday/test");
      const data = await res.json();
      setTestResult({ 
        success: data.success, 
        message: data.message || data.error,
        orderCount: data.orderCount
      });
    } catch (e) {
      setTestResult({ success: false, message: "Connection error" });
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div className="bg-white border border-stone-200 rounded-3xl shadow-sm overflow-hidden transition-all duration-300">
      <div className="bg-stone-50 border-b border-stone-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-stone-200 p-2 rounded-xl text-stone-700">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-black text-stone-900 uppercase tracking-tight">System Settings</h2>
            <p className="text-[10px] text-stone-500 font-mono uppercase tracking-widest">Global Configuration Panel</p>
          </div>
        </div>
      </div>

      <div className="border-b border-stone-200 flex overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('general')}
          className={`px-6 py-3 text-xs font-bold uppercase tracking-wider whitespace-nowrap border-b-2 transition-colors ${activeTab === 'general' ? 'border-stone-900 text-stone-900' : 'border-transparent text-stone-400 hover:text-stone-600'}`}
        >
          General
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('checkout')}
          className={`px-6 py-3 text-xs font-bold uppercase tracking-wider whitespace-nowrap border-b-2 transition-colors ${activeTab === 'checkout' ? 'border-stone-900 text-stone-900' : 'border-transparent text-stone-400 hover:text-stone-600'}`}
        >
          Checkout
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('features')}
          className={`px-6 py-3 text-xs font-bold uppercase tracking-wider whitespace-nowrap border-b-2 transition-colors ${activeTab === 'features' ? 'border-stone-900 text-stone-900' : 'border-transparent text-stone-400 hover:text-stone-600'}`}
        >
          Features
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('integrations')}
          className={`px-6 py-3 text-xs font-bold uppercase tracking-wider whitespace-nowrap border-b-2 transition-colors ${activeTab === 'integrations' ? 'border-stone-900 text-stone-900' : 'border-transparent text-stone-400 hover:text-stone-600'}`}
        >
          Integrations
        </button>
      </div>

      <form onSubmit={handleSave} className="p-6">
        {activeTab === 'general' && (
          <div className="space-y-6 animate-in fade-in">
            <div>
              <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1.5">
                Restaurant Name
              </label>
              <input
                type="text"
                value={settings.restaurantName || ""}
                onChange={e => handleChange("restaurantName", e.target.value)}
                placeholder="e.g. SAVORY"
                className="w-full text-sm bg-stone-50/50 border border-stone-300 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1.5">
                Logo URL
              </label>
              <div className="flex space-x-4 items-start">
                <input
                  type="text"
                  value={settings.logoUrl || ""}
                  onChange={e => handleChange("logoUrl", e.target.value)}
                  placeholder="https://example.com/logo.png"
                  className="flex-1 text-sm bg-stone-50/50 border border-stone-300 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all"
                />
                {settings.logoUrl && (
                  <div className="w-12 h-12 rounded-lg border border-stone-200 overflow-hidden shrink-0 flex items-center justify-center bg-stone-50">
                    <img src={settings.logoUrl} alt="Logo Preview" className="w-full h-full object-contain" />
                  </div>
                )}
              </div>
              <p className="text-[10px] text-stone-400 mt-2">Leave blank to use the default logo.</p>
            </div>
          </div>
        )}

        {activeTab === 'checkout' && (
          <div className="space-y-6 animate-in fade-in">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1.5">
                  Service Tax (%)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    required
                    value={settings.serviceTaxPercent}
                    onChange={e => handleChange("serviceTaxPercent", e.target.value)}
                    className="w-full text-xs bg-stone-50/50 border border-stone-300 rounded-xl pl-3 pr-8 py-3 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all font-medium"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-stone-400">%</span>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1.5">
                  Delivery Flat Fee (ETB)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    required
                    value={settings.flatFeeETB}
                    onChange={e => handleChange("flatFeeETB", e.target.value)}
                    className="w-full text-xs bg-stone-50/50 border border-stone-300 rounded-xl pl-3 pr-12 py-3 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all font-medium"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-stone-400">ETB</span>
                </div>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <label className="flex items-center justify-between p-4 bg-stone-50 border border-stone-200 rounded-2xl cursor-pointer hover:bg-stone-100 transition-all">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-white rounded-xl shadow-sm">
                    <CreditCard className="w-4 h-4 text-stone-600" />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-stone-800 uppercase tracking-tight leading-none">Cash Payment</span>
                    <span className="text-[9px] text-stone-400 font-medium">Enable COD</span>
                  </div>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.enableCOD}
                    onChange={e => handleChange("enableCOD", e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2.5px] after:start-[2.5px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                </div>
              </label>

              <label className="flex items-center justify-between p-4 bg-stone-50 border border-stone-200 rounded-2xl cursor-pointer hover:bg-stone-100 transition-all">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-white rounded-xl shadow-sm">
                    <RotateCcw className="w-4 h-4 text-stone-600" />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-stone-800 uppercase tracking-tight leading-none">Store Status</span>
                    <span className="text-[9px] text-stone-400 font-medium">Accept Orders</span>
                  </div>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.isOpen}
                    onChange={e => handleChange("isOpen", e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2.5px] after:start-[2.5px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                </div>
              </label>
            </div>
          </div>
        )}

        {activeTab === 'features' && (
          <div className="space-y-4 animate-in fade-in">
            <p className="text-xs text-stone-500 mb-4">Toggle optional features across the application. When disabled, their respective tabs and user-facing UI will be hidden.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="flex items-center justify-between p-4 bg-stone-50 border border-stone-200 rounded-2xl cursor-pointer hover:bg-stone-100 transition-all">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-white rounded-xl shadow-sm text-pink-600">
                    <Heart className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-stone-800 uppercase tracking-tight leading-none">Loyalty Program</span>
                    <span className="text-[9px] text-stone-400 font-medium">Points & Promos</span>
                  </div>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={settings.enableLoyalty} onChange={e => handleChange("enableLoyalty", e.target.checked)} className="sr-only peer" />
                  <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2.5px] after:start-[2.5px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                </div>
              </label>

              <label className="flex items-center justify-between p-4 bg-stone-50 border border-stone-200 rounded-2xl cursor-pointer hover:bg-stone-100 transition-all">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-white rounded-xl shadow-sm text-blue-600">
                    <Mail className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-stone-800 uppercase tracking-tight leading-none">Marketing</span>
                    <span className="text-[9px] text-stone-400 font-medium">Newsletter signups</span>
                  </div>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={settings.enableMarketing} onChange={e => handleChange("enableMarketing", e.target.checked)} className="sr-only peer" />
                  <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2.5px] after:start-[2.5px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                </div>
              </label>

              <label className="flex items-center justify-between p-4 bg-stone-50 border border-stone-200 rounded-2xl cursor-pointer hover:bg-stone-100 transition-all">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-white rounded-xl shadow-sm text-amber-600">
                    <CalendarDays className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-stone-800 uppercase tracking-tight leading-none">Reservations</span>
                    <span className="text-[9px] text-stone-400 font-medium">Table bookings</span>
                  </div>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={settings.enableReservations} onChange={e => handleChange("enableReservations", e.target.checked)} className="sr-only peer" />
                  <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2.5px] after:start-[2.5px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                </div>
              </label>
              
              <label className="flex items-center justify-between p-4 bg-stone-50 border border-stone-200 rounded-2xl cursor-pointer hover:bg-stone-100 transition-all">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-white rounded-xl shadow-sm text-purple-600">
                    <MessageSquare className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="block text-[10px] font-black text-stone-800 uppercase tracking-tight leading-none">AI Chatbot</span>
                    <span className="text-[9px] text-stone-400 font-medium">Customer assistant</span>
                  </div>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={settings.enableChatbot} onChange={e => handleChange("enableChatbot", e.target.checked)} className="sr-only peer" />
                  <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2.5px] after:start-[2.5px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                </div>
              </label>
            </div>
          </div>
        )}

        {activeTab === 'integrations' && (
          <div className="space-y-4 animate-in fade-in">
            <div className="flex flex-col space-y-3 p-4 bg-blue-50/30 rounded-2xl border border-blue-100">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-blue-700">
                  <Truck className="w-4 h-4" />
                  <div>
                    <span className="block text-[10px] font-bold uppercase tracking-wide">Shipday Delivery</span>
                    <span className="block text-[8px] text-blue-500 font-mono">INTEGRATION STATUS</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={testShipday}
                  disabled={testLoading}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold uppercase tracking-wider px-4 py-2 rounded-xl transition-all disabled:opacity-50 flex items-center space-x-2 shadow-sm"
                >
                  {testLoading ? <RotateCcw className="w-3 h-3 animate-spin" /> : <Truck className="w-3 h-3" />}
                  <span>{testLoading ? "Testing..." : "Verify Status"}</span>
                </button>
              </div>
              {testResult && (
                <div className={`p-3 rounded-xl border flex items-start space-x-2 animate-in fade-in slide-in-from-top-1 ${
                  testResult.success 
                    ? 'bg-emerald-50 border-emerald-100 text-emerald-800' 
                    : 'bg-rose-50 border-rose-100 text-rose-800'
                }`}>
                  {testResult.success ? (
                    <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  )}
                  <div className="text-[10px]">
                    <p className="font-bold">{testResult.success ? "Connection Active" : "Connection Error"}</p>
                    <p className="opacity-90">{testResult.message}</p>
                    {testResult.success && testResult.orderCount !== undefined && (
                      <p className="mt-1 font-mono text-[9px]">Total Orders in Shipday: {testResult.orderCount}</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col space-y-3 p-4 bg-emerald-50/30 rounded-2xl border border-emerald-100">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2 text-emerald-700">
                  <Settings className="w-4 h-4" />
                  <span className="text-[10px] font-bold uppercase tracking-wide">Website-Mailchimp Link</span>
                </div>
                <button
                  type="button"
                  onClick={testMailchimp}
                  disabled={testLoading}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold uppercase tracking-wider px-4 py-2 rounded-xl transition-all disabled:opacity-50 flex items-center space-x-2 shadow-sm"
                >
                  {testLoading ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                  <span>Test Connection</span>
                </button>
              </div>
              {mailchimpTestResult && (
                <div className={`flex items-center space-x-2 p-2 rounded-lg border ${mailchimpTestResult.success ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-rose-50 border-rose-100 text-rose-700'}`}>
                  {mailchimpTestResult.success ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                  <span className="text-[10px] font-medium leading-tight">{mailchimpTestResult.message}</span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-stone-100 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex-1">
            {error && (
              <div className="flex items-center space-x-2 text-rose-600 animate-in fade-in slide-in-from-left-2">
                <AlertCircle className="w-4 h-4" />
                <span className="text-xs font-bold uppercase tracking-tight">{error}</span>
              </div>
            )}
            {success && (
              <div className="flex items-center space-x-2 text-emerald-600 animate-in fade-in slide-in-from-left-2">
                <CheckCircle className="w-4 h-4" />
                <span className="text-xs font-bold uppercase tracking-tight">Configuration Synchronized</span>
              </div>
            )}
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full md:w-auto bg-stone-900 hover:bg-black text-white text-[11px] font-black uppercase tracking-widest px-10 py-4 rounded-2xl shadow-xl shadow-stone-900/10 transition-all hover:-translate-y-1 active:translate-y-0 disabled:opacity-50 disabled:translate-y-0 flex items-center justify-center space-x-2 cursor-pointer"
          >
            {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
            <span>Save Configuration</span>
          </button>
        </div>
      </form>
    </div>
  );
}


