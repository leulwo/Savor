/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { 
  History, Search, Filter, Shield, User, Clock, ChevronDown, ChevronRight, 
  RefreshCw, AlertCircle, ShoppingBag, Utensils, Settings, Users, Tag
} from "lucide-react";
import { db } from "../firebase";
import { collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";
import { AuditLogEntry } from "../types";
import { hasPermission, PermissionMap } from "../permissions";

interface AuditLogProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

export default function AuditLog({ can, permissions }: AuditLogProps) {
  const canView = can ? can("audit.view") : hasPermission(permissions, "audit.view");

  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }

    const q = query(
      collection(db, "audit_log"),
      orderBy("createdAt", "desc"),
      limit(200)
    );

    const unsub = onSnapshot(q, (snapshot) => {
      const entries = snapshot.docs.map(doc => ({
        id: doc.id,
        ...(doc.data() as any)
      })) as AuditLogEntry[];
      setLogs(entries);
      setLoading(false);
    }, (err) => {
      console.warn("Audit log real-time subscription error:", err);
      setLoading(false);
    });

    return () => unsub();
  }, [canView]);

  const filteredLogs = logs.filter(entry => {
    const matchesCategory = categoryFilter === 'all' || entry.category === categoryFilter;
    const q = searchQuery.toLowerCase();
    const matchesSearch = 
      !searchQuery ||
      (entry.action && entry.action.toLowerCase().includes(q)) ||
      (entry.actorEmail && entry.actorEmail.toLowerCase().includes(q)) ||
      (entry.targetId && entry.targetId.toLowerCase().includes(q));

    return matchesCategory && matchesSearch;
  });

  const getCategoryBadge = (cat: string) => {
    switch (cat) {
      case 'order':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200"><ShoppingBag className="w-3 h-3" /> Order</span>;
      case 'menu':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200"><Utensils className="w-3 h-3" /> Menu</span>;
      case 'settings':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200"><Settings className="w-3 h-3" /> Settings</span>;
      case 'team':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><Shield className="w-3 h-3" /> Team</span>;
      case 'customer':
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-pink-50 text-pink-700 border border-pink-200"><Users className="w-3 h-3" /> Customer</span>;
      default:
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-stone-100 text-stone-700 border border-stone-200"><Tag className="w-3 h-3" /> General</span>;
    }
  };

  const formatTimestamp = (ts: any) => {
    if (!ts) return "Just now";
    try {
      const date = ts.toDate ? ts.toDate() : new Date(ts);
      return isNaN(date.getTime()) ? "Just now" : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) {
      return "Just now";
    }
  };

  if (!canView) {
    return (
      <div className="p-8 bg-amber-50/60 border border-amber-200 rounded-2xl text-stone-700 text-center">
        <AlertCircle className="w-8 h-8 text-amber-600 mx-auto mb-2" />
        <h3 className="font-bold text-base text-stone-900">Access Restricted</h3>
        <p className="text-xs text-stone-600 mt-1">You need the "View activity audit logs" permission to access this module.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <div className="bg-white p-6 rounded-2xl border border-stone-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <History className="w-5 h-5 text-amber-600" />
            <h2 className="text-lg font-bold font-serif text-stone-900">System Activity & Audit Log</h2>
          </div>
          <p className="text-xs text-stone-500 mt-0.5">Immutable audit trail of administrator and staff operational actions</p>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="text-xs bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 text-stone-700 font-bold focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          >
            <option value="all">All Categories</option>
            <option value="order">Orders</option>
            <option value="menu">Menu</option>
            <option value="settings">Settings</option>
            <option value="team">Team & Roles</option>
            <option value="customer">Customers</option>
          </select>

          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              placeholder="Search by action, email..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all"
            />
          </div>
        </div>
      </div>

      {/* Main Timeline Card */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-stone-50/50 border-b border-stone-100 flex items-center justify-between">
          <h3 className="font-bold text-xs uppercase tracking-wider text-stone-700">Activity Stream ({filteredLogs.length} entries)</h3>
          <span className="text-[11px] text-stone-400 font-mono flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" /> Stream
          </span>
        </div>

        {loading ? (
          <div className="p-12 text-center text-stone-400 text-xs">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-amber-500" />
            Loading audit records...
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="p-12 text-center text-stone-400 text-xs">
            <History className="w-8 h-8 mx-auto mb-2 text-stone-300" />
            {searchQuery || categoryFilter !== 'all' ? "No audit records found matching your filters." : "No audit entries recorded yet."}
          </div>
        ) : (
          <div className="divide-y divide-stone-100">
            {filteredLogs.map(entry => {
              const isExpanded = expandedLogId === entry.id;
              const hasDetails = entry.details && Object.keys(entry.details).length > 0;

              return (
                <div key={entry.id} className="p-4 hover:bg-amber-50/20 transition-colors">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    {/* Left: Category & Action */}
                    <div className="flex items-start space-x-3">
                      <div className="mt-0.5 shrink-0">
                        {getCategoryBadge(entry.category || 'general')}
                      </div>
                      <div>
                        <p className="text-xs font-bold text-stone-900 leading-snug">{entry.action}</p>
                        <div className="flex items-center gap-2 text-[11px] text-stone-400 mt-0.5">
                          <span className="font-medium text-stone-600">{entry.actorEmail || 'System'}</span>
                          <span>•</span>
                          <span className="font-mono uppercase text-[10px] bg-stone-100 px-1.5 py-0.5 rounded text-stone-500">{entry.actorRole || 'admin'}</span>
                          {entry.targetId && (
                            <>
                              <span>•</span>
                              <span className="font-mono text-[10px] text-stone-500">ID: {entry.targetId}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right: Timestamp & Details Toggle */}
                    <div className="flex items-center space-x-3 sm:self-center self-end">
                      <span className="text-[11px] font-mono text-stone-400 whitespace-nowrap">
                        {formatTimestamp(entry.createdAt)}
                      </span>

                      {hasDetails && (
                        <button
                          onClick={() => setExpandedLogId(isExpanded ? null : (entry.id || null))}
                          className="p-1 text-stone-400 hover:text-stone-700 transition-colors cursor-pointer rounded"
                          title="View Details"
                        >
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded JSON Inspector */}
                  {isExpanded && hasDetails && (
                    <div className="mt-3 p-3 bg-stone-900 text-amber-400 font-mono text-[11px] rounded-xl overflow-x-auto shadow-inner">
                      <p className="text-[10px] text-stone-400 uppercase font-bold mb-1">// Metadata Details</p>
                      <pre>{JSON.stringify(entry.details, null, 2)}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
