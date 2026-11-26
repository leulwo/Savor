import React, { useState, useEffect, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Mail,
  MessageSquareText,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Truck,
  Webhook,
  XCircle,
  CreditCard,
} from "lucide-react";
import { authedFetch } from "../firebase";
import { PermissionMap } from "../permissions";
import { confirmDialog, toastError, toastSuccess } from "../notify";
import AuditLog from "./AuditLog";

interface DevToolsPanelProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

interface IntegrationProbe {
  ok: boolean;
  status: "healthy" | "error" | "unconfigured" | string;
  latencyMs: number;
  message: string;
  orderCount?: number;
  mode?: string;
  webhookReady?: boolean;
}

interface DiagnosticsPayload {
  generatedAt: string;
  runtime: {
    nodeVersion: string;
    nodeEnv: string;
    appUrl: string;
    trustProxyCidrs: string | null;
    uptimeSeconds: number;
    startedAt: string;
    memoryMb: { rss: number; heapUsed: number; heapTotal: number };
  };
  database: {
    filename: string;
    sizeBytes: number;
    totalDocuments: number;
    collections: Record<string, number>;
  };
  envMatrix: Array<{
    key: string;
    group: string;
    status: "configured" | "missing" | "placeholder";
    detail?: string;
  }>;
  stuckOrders: Array<{
    id: string;
    status: string;
    paymentMethod: string;
    paymentStatus: string;
    paymentAttemptStatus: string | null;
    paymentReconciliationRequired: boolean;
    shipdayDispatchState: string | null;
    shipdayDispatchError: string | null;
    total: number | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  eventSummary: {
    total: number;
    smsSuccess: number;
    smsFailed: number;
    errors: number;
    webhooks: number;
    payments: number;
    auth: number;
    integrations: number;
  };
}

interface DevEventItem {
  id: string;
  category: "sms" | "error" | "webhook" | "payment" | "integration" | "auth";
  status: "success" | "failed" | "warning";
  source: string;
  summary: string;
  orderId?: string;
  recipient?: string;
  httpStatus?: number;
  latencyMs?: number;
  code?: string;
  details?: Record<string, any>;
  createdAt: string;
}

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function DevToolsPanel({ can, permissions }: DevToolsPanelProps) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsPayload | null>(null);
  const [events, setEvents] = useState<DevEventItem[]>([]);
  const [eventCounts, setEventCounts] = useState<DiagnosticsPayload["eventSummary"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [suiteLoading, setSuiteLoading] = useState(false);
  const [shipdayLoading, setShipdayLoading] = useState(false);
  const [mailchimpLoading, setMailchimpLoading] = useState(false);
  const [shipdayQuickResult, setShipdayQuickResult] = useState<{ success: boolean; message: string; orderCount?: number } | null>(null);
  const [mailchimpQuickResult, setMailchimpQuickResult] = useState<{ success: boolean; message: string } | null>(null);
  const [suiteResult, setSuiteResult] = useState<{ checkedAt: string; results: Record<string, IntegrationProbe> } | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [showEnvMatrix, setShowEnvMatrix] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({
        category: categoryFilter,
        status: statusFilter,
        limit: "120",
      });
      if (searchQuery.trim()) params.set("q", searchQuery.trim());

      const [diagRes, eventsRes] = await Promise.all([
        authedFetch("/api/dev/diagnostics"),
        authedFetch(`/api/dev/events?${params.toString()}`),
      ]);

      const diagData = await diagRes.json();
      const eventsData = await eventsRes.json();
      if (!diagRes.ok) throw new Error(diagData?.error || "Failed to load diagnostics.");
      if (!eventsRes.ok) throw new Error(eventsData?.error || "Failed to load event logs.");

      setDiagnostics(diagData);
      setEvents(Array.isArray(eventsData.events) ? eventsData.events : []);
      setEventCounts(eventsData.counts || diagData.eventSummary || null);
    } catch (err: any) {
      setLoadError(err?.message || "Could not load developer diagnostics.");
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, statusFilter, searchQuery]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const runHealthSuite = async () => {
    setSuiteLoading(true);
    try {
      const res = await authedFetch("/api/dev/integrations/check", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Health check suite failed.");
      setSuiteResult(data);
      toastSuccess("Integration health suite finished.");
      void loadAll();
    } catch (err: any) {
      toastError(err?.message || "Health check suite failed.");
    } finally {
      setSuiteLoading(false);
    }
  };

  const testShipday = async () => {
    setShipdayLoading(true);
    setShipdayQuickResult(null);
    try {
      const res = await authedFetch("/api/shipday/test");
      const data = await res.json();
      setShipdayQuickResult({ success: !!data.success, message: data.message || data.error, orderCount: data.orderCount });
    } catch {
      setShipdayQuickResult({ success: false, message: "Connection error" });
    } finally {
      setShipdayLoading(false);
    }
  };

  const testMailchimp = async () => {
    setMailchimpLoading(true);
    setMailchimpQuickResult(null);
    try {
      const res = await authedFetch("/api/mailchimp/test");
      const data = await res.json();
      setMailchimpQuickResult({ success: !!data.success, message: data.message || data.error });
    } catch {
      setMailchimpQuickResult({ success: false, message: "Network error while testing connection." });
    } finally {
      setMailchimpLoading(false);
    }
  };

  const handleClearEvents = () => {
    confirmDialog(
      "Clear developer troubleshooting logs (dev_events)?\n\nBusiness records and the immutable audit log will NOT be affected.",
      async () => {
        try {
          const res = await authedFetch("/api/dev/events/clear", { method: "POST" });
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data?.error || "Failed to clear logs.");
          toastSuccess(`Cleared ${data.cleared || 0} diagnostic log entries.`);
          void loadAll();
        } catch (err: any) {
          toastError(err?.message || "Could not clear logs.");
        }
      },
      null,
      "Clear Logs"
    );
  };

  const copyDiagnosticBundle = async () => {
    try {
      const bundle = {
        copiedAt: new Date().toISOString(),
        diagnostics,
        healthSuite: suiteResult,
        recentEvents: events.slice(0, 50),
      };
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      toastSuccess("Sanitized diagnostic snapshot copied to clipboard.");
    } catch {
      toastError("Clipboard copy failed.");
    }
  };

  const counts = eventCounts || diagnostics?.eventSummary;

  const probeBadge = (probe?: IntegrationProbe) => {
    if (!probe) return <span className="text-[10px] font-mono text-stone-400">Not tested</span>;
    if (probe.ok) {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
          <CheckCircle2 className="w-3 h-3" /> {probe.latencyMs}ms
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">
        <XCircle className="w-3 h-3" /> {probe.status}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="p-4 sm:p-5 bg-stone-900 text-stone-100 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold uppercase tracking-wider">Developer Diagnostics & Tools</h3>
            </div>
            <p className="text-[11px] text-stone-400 mt-1">Live integration probes, SMS & webhook delivery logs, stuck payment watchlist, and runtime metrics.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={runHealthSuite}
            disabled={suiteLoading}
            className="inline-flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-stone-950 text-[10px] font-black uppercase tracking-wider px-3.5 py-2 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
          >
            <Activity className={`w-3.5 h-3.5 ${suiteLoading ? "animate-pulse" : ""}`} />
            <span>{suiteLoading ? "Checking..." : "Run Health Suite"}</span>
          </button>
          <button
            type="button"
            onClick={copyDiagnosticBundle}
            className="inline-flex items-center gap-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-xl border border-stone-700 transition-colors cursor-pointer"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>Copy Bundle</span>
          </button>
          <button
            type="button"
            onClick={loadAll}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-xl border border-stone-700 transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {loadError && (
        <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {/* Runtime & DB Telemetry Cards */}
      {diagnostics && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="p-4 rounded-2xl border border-stone-200 bg-stone-50/70">
            <div className="flex items-center justify-between text-stone-500 mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider">Server Runtime</span>
              <Server className="w-4 h-4" />
            </div>
            <p className="text-base font-black text-stone-900 font-mono">{formatUptime(diagnostics.runtime.uptimeSeconds)}</p>
            <p className="text-[10px] text-stone-500 font-mono mt-1 truncate">
              {diagnostics.runtime.nodeVersion} · {diagnostics.runtime.nodeEnv}
            </p>
          </div>

          <div className="p-4 rounded-2xl border border-stone-200 bg-stone-50/70">
            <div className="flex items-center justify-between text-stone-500 mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider">Memory Usage</span>
              <Activity className="w-4 h-4" />
            </div>
            <p className="text-base font-black text-stone-900 font-mono">{diagnostics.runtime.memoryMb.rss} MB RSS</p>
            <p className="text-[10px] text-stone-500 font-mono mt-1">
              Heap: {diagnostics.runtime.memoryMb.heapUsed} / {diagnostics.runtime.memoryMb.heapTotal} MB
            </p>
          </div>

          <div className="p-4 rounded-2xl border border-stone-200 bg-stone-50/70">
            <div className="flex items-center justify-between text-stone-500 mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider">SQLite Database</span>
              <Database className="w-4 h-4" />
            </div>
            <p className="text-base font-black text-stone-900 font-mono">{diagnostics.database.totalDocuments} docs</p>
            <p className="text-[10px] text-stone-500 font-mono mt-1 truncate">
              {diagnostics.database.filename} ({formatBytes(diagnostics.database.sizeBytes)})
            </p>
          </div>

          <div className={`p-4 rounded-2xl border ${diagnostics.stuckOrders.length > 0 ? "border-amber-300 bg-amber-50/60" : "border-emerald-200 bg-emerald-50/40"}`}>
            <div className="flex items-center justify-between text-stone-600 mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider">Stuck / Reconciliation</span>
              <AlertTriangle className={`w-4 h-4 ${diagnostics.stuckOrders.length > 0 ? "text-amber-600" : "text-emerald-600"}`} />
            </div>
            <p className="text-base font-black text-stone-900 font-mono">{diagnostics.stuckOrders.length} orders</p>
            <p className="text-[10px] text-stone-600 mt-1">
              {diagnostics.stuckOrders.length > 0 ? "Review watchlist below" : "All payment & delivery states clean"}
            </p>
          </div>
        </div>
      )}

      {/* Integration Health Suite & Quick Probes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col space-y-3 p-4 bg-blue-50/30 rounded-2xl border border-blue-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-blue-700">
              <Truck className="w-4 h-4" />
              <div>
                <span className="block text-[10px] font-bold uppercase tracking-wide">Shipday Delivery & SMS</span>
                <span className="block text-[9px] text-blue-500 font-mono">DISPATCH & TRACKING API</span>
              </div>
            </div>
            <button
              type="button"
              onClick={testShipday}
              disabled={shipdayLoading}
              className="bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold uppercase tracking-wider px-3.5 py-2 rounded-xl transition-all disabled:opacity-50 flex items-center space-x-1.5 shadow-sm cursor-pointer"
            >
              {shipdayLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Truck className="w-3 h-3" />}
              <span>{shipdayLoading ? "Testing..." : "Test Shipday"}</span>
            </button>
          </div>
          {shipdayQuickResult && (
            <div className={`p-2.5 rounded-xl border flex items-start space-x-2 text-[10px] ${shipdayQuickResult.success ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-800"}`}>
              {shipdayQuickResult.success ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <div>
                <p className="font-bold">{shipdayQuickResult.message}</p>
                {shipdayQuickResult.orderCount !== undefined && <p className="font-mono text-[9px] mt-0.5">Active Shipday orders: {shipdayQuickResult.orderCount}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col space-y-3 p-4 bg-emerald-50/30 rounded-2xl border border-emerald-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-emerald-700">
              <Mail className="w-4 h-4" />
              <div>
                <span className="block text-[10px] font-bold uppercase tracking-wide">Mailchimp Audience</span>
                <span className="block text-[9px] text-emerald-600 font-mono">NEWSLETTER MARKETING API</span>
              </div>
            </div>
            <button
              type="button"
              onClick={testMailchimp}
              disabled={mailchimpLoading}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold uppercase tracking-wider px-3.5 py-2 rounded-xl transition-all disabled:opacity-50 flex items-center space-x-1.5 shadow-sm cursor-pointer"
            >
              {mailchimpLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              <span>{mailchimpLoading ? "Testing..." : "Test Mailchimp"}</span>
            </button>
          </div>
          {mailchimpQuickResult && (
            <div className={`p-2.5 rounded-xl border flex items-start space-x-2 text-[10px] ${mailchimpQuickResult.success ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-800"}`}>
              {mailchimpQuickResult.success ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <span className="font-bold">{mailchimpQuickResult.message}</span>
            </div>
          )}
        </div>
      </div>

      {/* Multi-integration Suite Results */}
      {suiteResult && (
        <div className="p-4 rounded-2xl border border-stone-200 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-stone-800">Full Health Suite Results</span>
            <span className="text-[10px] font-mono text-stone-400">Checked {new Date(suiteResult.checkedAt).toLocaleTimeString()}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
            {([
              ["shipday", "Shipday"],
              ["mailchimp", "Mailchimp"],
              ["chapa", "Chapa"],
              ["firebaseAuth", "Firebase Auth"],
              ["sqlite", "SQLite"],
            ] as const).map(([key, label]) => {
              const probe = suiteResult.results[key];
              return (
                <div key={key} className="p-3 rounded-xl border border-stone-200 bg-stone-50/70 space-y-1.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[11px] font-bold text-stone-800">{label}</span>
                    {probeBadge(probe)}
                  </div>
                  <p className="text-[10px] text-stone-600 leading-snug">{probe?.message || "—"}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Environment Config Matrix (Collapsible, Secret-Free) */}
      {diagnostics && (
        <div className="border border-stone-200 rounded-2xl overflow-hidden bg-white">
          <button
            type="button"
            onClick={() => setShowEnvMatrix(v => !v)}
            className="w-full px-4 py-3 bg-stone-50 flex items-center justify-between text-left cursor-pointer hover:bg-stone-100/70 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-stone-600" />
              <span className="text-xs font-bold uppercase tracking-wider text-stone-800">Environment & Integration Config Matrix</span>
              <span className="text-[10px] font-mono text-stone-500">
                ({diagnostics.envMatrix.filter(e => e.status === "configured").length}/{diagnostics.envMatrix.length} configured)
              </span>
            </div>
            {showEnvMatrix ? <ChevronDown className="w-4 h-4 text-stone-400" /> : <ChevronRight className="w-4 h-4 text-stone-400" />}
          </button>
          {showEnvMatrix && (
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 border-t border-stone-200">
              {diagnostics.envMatrix.map(item => (
                <div key={item.key} className="p-2.5 rounded-xl border border-stone-200 bg-stone-50/40 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] font-mono font-bold text-stone-800 truncate">{item.key}</p>
                    <p className="text-[9px] text-stone-500 truncate">{item.group}{item.detail ? ` · ${item.detail}` : ""}</p>
                  </div>
                  <span className={`shrink-0 text-[9px] font-mono uppercase px-2 py-0.5 rounded-full font-bold ${
                    item.status === "configured"
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : item.status === "placeholder"
                        ? "bg-amber-50 text-amber-700 border border-amber-200"
                        : "bg-rose-50 text-rose-700 border border-rose-200"
                  }`}>
                    {item.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SMS & Error Troubleshooting Logs */}
      <div className="border border-stone-200 rounded-2xl bg-white overflow-hidden">
        <div className="p-4 bg-stone-50 border-b border-stone-200 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-black uppercase tracking-wider text-stone-900">SMS, Webhook & Error Logs</h4>
              <p className="text-[10px] text-stone-500">Captures Shipday & Chapa phone/SMS dispatches, payment/webhook failures, auth errors, and HTTP 5xx traces.</p>
            </div>
            <button
              type="button"
              onClick={handleClearEvents}
              className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-rose-600 hover:text-rose-700 px-2.5 py-1.5 rounded-lg border border-rose-200 bg-rose-50/60 hover:bg-rose-50 cursor-pointer self-start sm:self-auto"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear Diagnostic Logs</span>
            </button>
          </div>

          {/* Summary KPI Pills */}
          {counts && (
            <div className="flex flex-wrap gap-2 text-[10px] font-mono">
              <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
                SMS OK: {counts.smsSuccess}
              </span>
              <span className="px-2.5 py-1 rounded-full bg-rose-50 text-rose-800 border border-rose-200 font-bold">
                SMS Failed: {counts.smsFailed}
              </span>
              <span className="px-2.5 py-1 rounded-full bg-stone-100 text-stone-700 border border-stone-200 font-bold">
                Errors: {counts.errors}
              </span>
              <span className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-800 border border-blue-200 font-bold">
                Webhooks: {counts.webhooks}
              </span>
              <span className="px-2.5 py-1 rounded-full bg-purple-50 text-purple-800 border border-purple-200 font-bold">
                Payments: {counts.payments}
              </span>
              <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                Auth: {counts.auth}
              </span>
            </div>
          )}

          {/* Category + Status + Search Filters */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex flex-wrap gap-1.5">
              {[
                ["all", "All Logs"],
                ["sms", "SMS Log"],
                ["error", "Errors"],
                ["webhook", "Webhooks"],
                ["payment", "Payments"],
                ["auth", "Auth"],
                ["integration", "Health Checks"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCategoryFilter(id)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                    categoryFilter === id
                      ? "bg-stone-900 text-white"
                      : "bg-white text-stone-600 border border-stone-200 hover:bg-stone-100"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="text-[11px] bg-white border border-stone-200 rounded-xl px-2.5 py-1.5 text-stone-700 font-bold"
              >
                <option value="all">All Statuses</option>
                <option value="success">Success Only</option>
                <option value="failed">Failed Only</option>
                <option value="warning">Warnings Only</option>
              </select>
              <div className="relative flex-1 sm:w-52">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Order ID, code, phone..."
                  className="w-full pl-8 pr-3 py-1.5 text-[11px] bg-white border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Event Stream List */}
        <div className="divide-y divide-stone-100 max-h-96 overflow-y-auto">
          {events.length === 0 ? (
            <div className="p-8 text-center text-xs text-stone-400">
              No diagnostic events match the current filter yet.
            </div>
          ) : (
            events.map(ev => {
              const isOpen = expandedEventId === ev.id;
              return (
                <div key={ev.id} className="p-3.5 hover:bg-stone-50/70 transition-colors">
                  <div
                    className="flex flex-wrap items-start justify-between gap-2 cursor-pointer"
                    onClick={() => setExpandedEventId(isOpen ? null : ev.id)}
                  >
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <span className={`mt-0.5 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded font-bold shrink-0 ${
                        ev.status === "success"
                          ? "bg-emerald-100 text-emerald-800"
                          : ev.status === "failed"
                            ? "bg-rose-100 text-rose-800"
                            : "bg-amber-100 text-amber-800"
                      }`}>
                        {ev.status}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-stone-900 break-words">{ev.summary}</p>
                        <div className="flex flex-wrap items-center gap-2 mt-1 text-[10px] font-mono text-stone-500">
                          <span className="uppercase px-1.5 py-0.5 rounded bg-stone-100 text-stone-700">{ev.category}</span>
                          <span>{ev.source}</span>
                          {ev.orderId && <span className="text-amber-700 font-bold">Order #{ev.orderId}</span>}
                          {ev.recipient && <span className="inline-flex items-center gap-1"><MessageSquareText className="w-3 h-3" /> {ev.recipient}</span>}
                          {ev.code && <span className="text-rose-700">{ev.code}</span>}
                          {ev.httpStatus !== undefined && <span>HTTP {ev.httpStatus}</span>}
                          {ev.latencyMs !== undefined && <span>{ev.latencyMs}ms</span>}
                        </div>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-stone-400 shrink-0">
                      {new Date(ev.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {isOpen && ev.details && (
                    <pre className="mt-2.5 p-2.5 rounded-xl bg-stone-900 text-stone-200 text-[10px] font-mono overflow-x-auto">
                      {JSON.stringify(ev.details, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Stuck Orders & Reconciliation Watchlist */}
      {diagnostics && diagnostics.stuckOrders.length > 0 && (
        <div className="border border-amber-200 rounded-2xl bg-amber-50/40 overflow-hidden">
          <div className="px-4 py-3 bg-amber-100/60 border-b border-amber-200 flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-amber-800" />
            <h4 className="text-xs font-black uppercase tracking-wider text-amber-950">
              Stuck Orders & Reconciliation Watchlist ({diagnostics.stuckOrders.length})
            </h4>
          </div>
          <div className="divide-y divide-amber-200/60">
            {diagnostics.stuckOrders.map(order => (
              <div key={order.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div>
                  <span className="font-mono font-bold text-stone-900">#{order.id}</span>
                  <span className="ml-2 text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-white border border-amber-200 text-stone-700">
                    {order.paymentMethod} · {order.paymentStatus}
                  </span>
                  {order.paymentAttemptStatus && (
                    <span className="ml-1.5 text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-200/70 text-amber-950">
                      attempt: {order.paymentAttemptStatus}
                    </span>
                  )}
                  {order.shipdayDispatchState && (
                    <span className="ml-1.5 text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-rose-100 text-rose-800">
                      shipday: {order.shipdayDispatchState}
                    </span>
                  )}
                  {order.shipdayDispatchError && (
                    <p className="text-[11px] text-rose-700 mt-1">{order.shipdayDispatchError}</p>
                  )}
                </div>
                <div className="text-[10px] font-mono text-stone-500">
                  {order.total !== null ? `${order.total.toFixed(2)} ETB · ` : ""}
                  {order.createdAt ? new Date(order.createdAt).toLocaleString() : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Existing Immutable Audit Trail */}
      <div className="pt-2 border-t border-stone-200">
        <AuditLog can={can} permissions={permissions} />
      </div>
    </div>
  );
}
