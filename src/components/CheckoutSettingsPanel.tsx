/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Savory Restaurant
 */

import React, { useState, useEffect } from "react";
import { Settings, Save, AlertCircle, CheckCircle, RotateCcw, Truck, CreditCard, ChevronDown, ChevronUp } from "lucide-react";

export default function CheckoutSettingsPanel() {
  const [serviceTaxPercent, setServiceTaxPercent] = useState<number>(15);
  const [flatFeeETB, setFlatFeeETB] = useState<number>(0);
  const [enableCOD, setEnableCOD] = useState<boolean>(true);
  const [isOpen, setIsOpen] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; orderCount?: number } | null>(null);
  const [mailchimpTestResult, setMailchimpTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        if (data) {
          setServiceTaxPercent(data.serviceTaxPercent !== undefined ? data.serviceTaxPercent : 15);
          setFlatFeeETB(data.flatFeeETB !== undefined ? data.flatFeeETB : 0);
          setEnableCOD(data.enableCOD !== undefined ? data.enableCOD : true);
          setIsOpen(data.isOpen !== undefined ? data.isOpen : true);
        }
      } catch (e) {
        console.error("Failed to load settings", e);
        setError("Failed to load current settings");
      }
    };
    fetchSettings();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceTaxPercent,
          flatFeeETB,
          enableCOD,
          isOpen
        })
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        setError(data.error || "Failed to save settings");
      }
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
      <div 
        className="bg-stone-50 border-b border-stone-150 px-6 py-4 flex items-center justify-between cursor-pointer group"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center space-x-3">
          <div className="bg-amber-100 p-2 rounded-xl text-amber-700 group-hover:scale-110 transition-transform">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-sm font-black text-stone-900 uppercase tracking-tight">Advanced Store Settings</h2>
              {isCollapsed ? <ChevronDown className="w-4 h-4 text-stone-400" /> : <ChevronUp className="w-4 h-4 text-stone-400" />}
            </div>
            <p className="text-[10px] text-stone-400 font-mono uppercase tracking-widest">Global Configuration Panel</p>
          </div>
        </div>
        <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center space-x-1.5 ${isOpen ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${isOpen ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
          <span>{isOpen ? 'Store Accepting Orders' : 'Store Temporarily Closed'}</span>
        </div>
      </div>

      <div className={`transition-all duration-500 ease-in-out ${isCollapsed ? 'max-h-0' : 'max-h-[2000px]'}`}>
        <form onSubmit={handleSave} className="p-6 space-y-8">
          {/* Pricing & Fees Section */}
          <section className="space-y-4">
            <div className="flex items-center space-x-2 pb-1 border-b border-stone-100">
              <div className="p-1 bg-amber-50 rounded-md text-amber-600">
                <span className="text-[10px] font-black font-mono">01</span>
              </div>
              <h3 className="text-[11px] font-black text-stone-500 uppercase tracking-wider">Pricing & Fees</h3>
            </div>
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
                    value={serviceTaxPercent}
                    onChange={e => setServiceTaxPercent(parseFloat(e.target.value) || 0)}
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
                    value={flatFeeETB}
                    onChange={e => setFlatFeeETB(parseFloat(e.target.value) || 0)}
                    className="w-full text-xs bg-stone-50/50 border border-stone-300 rounded-xl pl-3 pr-12 py-3 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all font-medium"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-stone-400">ETB</span>
                </div>
              </div>
            </div>
          </section>

          {/* Shipday Integration Section */}
          <section className="space-y-4">
            <div className="flex items-center space-x-2 pb-1 border-b border-stone-100">
              <div className="p-1 bg-blue-50 rounded-md text-blue-600">
                <span className="text-[10px] font-black font-mono">02</span>
              </div>
              <h3 className="text-[11px] font-black text-stone-500 uppercase tracking-wider">Logistics (Shipday)</h3>
            </div>
            
            <div className="space-y-4">
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
            </div>
          </section>

          {/* Mailchimp Section */}
          <section className="space-y-4">
            <div className="flex items-center space-x-2 pb-1 border-b border-stone-100">
              <div className="p-1 bg-emerald-50 rounded-md text-emerald-600">
                <span className="text-[10px] font-black font-mono">03</span>
              </div>
              <h3 className="text-[11px] font-black text-stone-500 uppercase tracking-wider">Marketing (Mailchimp)</h3>
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
          </section>

          {/* Feature Toggles Section */}
          <section className="space-y-4">
            <div className="flex items-center space-x-2 pb-1 border-b border-stone-100">
              <div className="p-1 bg-stone-100 rounded-md text-stone-600">
                <span className="text-[10px] font-black font-mono">04</span>
              </div>
              <h3 className="text-[11px] font-black text-stone-500 uppercase tracking-wider">Core Feature Controls</h3>
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
                    checked={enableCOD}
                    onChange={e => setEnableCOD(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2.5px] after:start-[2.5px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
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
                    checked={isOpen}
                    onChange={e => setIsOpen(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2.5px] after:start-[2.5px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                </div>
              </label>
            </div>
          </section>

          <div className="pt-6 border-t border-stone-100 flex flex-col md:flex-row items-center justify-between gap-4">
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
              className="w-full md:w-auto bg-stone-900 hover:bg-black text-white text-[11px] font-black uppercase tracking-widest px-10 py-4 rounded-2xl shadow-xl shadow-stone-900/10 transition-all hover:-translate-y-1 active:translate-y-0 disabled:opacity-50 disabled:translate-y-0 flex items-center justify-center space-x-2"
            >
              {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
              <span>Save Configuration</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

