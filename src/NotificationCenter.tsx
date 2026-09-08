import { useEffect, useRef, useState } from "react";
import { db } from "./firebase";
import { collection, query, orderBy, onSnapshot, doc, updateDoc, addDoc, writeBatch, limit } from "firebase/firestore";
import { Bell, X, Receipt, Clock, AlertCircle, Sparkles } from "lucide-react";
import { toastSuccess } from "./notify";

export interface AppNotification {
  id: string;
  type: "order_paid" | "order_placed" | "order_failed" | "promo" | "system";
  title: string;
  body: string;
  read: boolean;
  createdAt: number;
  orderId?: string;
  amount?: number;
}

function requestPushPermission(): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function sendBrowserNotification(title: string, body: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, {
      body,
      icon: "/logo.png",
      badge: "/logo.png",
      tag: "savory-order"
    });
  } catch {
    // some browsers throw if called from non-secure context
  }
}

export async function pushNotification(opts: {
  uid: string;
  type: AppNotification["type"];
  title: string;
  body: string;
  orderId?: string;
  amount?: number;
}): Promise<void> {
  try {
    await addDoc(collection(db, "users", opts.uid, "notifications"), {
      type: opts.type,
      title: opts.title,
      body: opts.body,
      read: false,
      createdAt: Date.now(),
      orderId: opts.orderId || null,
      amount: opts.amount || null
    });
  } catch (e) {
    console.error("[notifications] failed to persist:", e);
  }
  // Always try to fire a browser push for instant feedback
  sendBrowserNotification(opts.title, opts.body);
  // And a corner toast
  toastSuccess(opts.title);
}

export function NotificationCenter({ uid }: { uid: string | null }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);

  // Ask for push permission once when the user becomes available
  useEffect(() => {
    if (uid) requestPushPermission();
  }, [uid]);

  // Live subscription to notifications
  useEffect(() => {
    if (!uid) {
      setItems([]);
      setUnread(0);
      return;
    }
    const q = query(
      collection(db, "users", uid, "notifications"),
      orderBy("createdAt", "desc"),
      limit(20)
    );
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as AppNotification));
      setItems(list);
      setUnread(list.filter(n => !n.read).length);
    }, (err) => {
      console.warn("[notifications] snapshot error:", err?.message);
    });
    return () => unsub();
  }, [uid]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const markAllRead = async () => {
    if (!uid) return;
    const unreadDocs = items.filter(n => !n.read).map(n => doc(db, "users", uid, "notifications", n.id));
    if (unreadDocs.length === 0) return;
    const batch = writeBatch(db);
    unreadDocs.forEach(d => batch.update(d, { read: true }));
    try { await batch.commit(); } catch (e) { console.error(e); }
  };

  const markRead = async (id: string) => {
    if (!uid) return;
    try { await updateDoc(doc(db, "users", uid, "notifications", id), { read: true }); } catch {}
  };

  if (!uid) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(o => !o); if (!open) setTimeout(markAllRead, 600); }}
        className="relative p-2.5 border border-stone-200 hover:border-stone-400 bg-stone-50 hover:bg-stone-100 rounded-xl transition-all cursor-pointer flex items-center text-stone-800"
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell className="w-4.5 h-4.5" />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 bg-rose-600 text-white font-mono text-[9px] font-bold min-w-5 h-5 px-1 rounded-full flex items-center justify-center animate-scale-up">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white border border-stone-200 rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-600" />
              <span className="font-bold text-stone-900 text-sm">Notifications</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-stone-400 hover:text-stone-700 p-1 rounded cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-10 text-center text-stone-400 text-sm">
                <Bell className="w-8 h-8 mx-auto mb-2 text-stone-300" />
                No notifications yet — your order updates will appear here.
              </div>
            ) : (
              items.map(n => (
                <button
                  key={n.id}
                  onClick={() => markRead(n.id)}
                  className={`w-full text-left px-4 py-3 border-b border-stone-50 hover:bg-stone-50 transition-colors flex gap-3 ${!n.read ? "bg-amber-50/40" : ""}`}
                >
                  <div className="shrink-0 mt-0.5">
                    {n.type === "order_paid" && <Receipt className="w-5 h-5 text-emerald-600" />}
                    {n.type === "order_placed" && <Clock className="w-5 h-5 text-amber-600" />}
                    {n.type === "order_failed" && <AlertCircle className="w-5 h-5 text-rose-600" />}
                    {n.type === "promo" && <Sparkles className="w-5 h-5 text-purple-600" />}
                    {n.type === "system" && <Bell className="w-5 h-5 text-stone-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-stone-900 text-sm truncate">{n.title}</p>
                      {!n.read && <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />}
                    </div>
                    <p className="text-xs text-stone-500 mt-0.5 line-clamp-2">{n.body}</p>
                    <p className="text-[10px] text-stone-400 mt-1 font-mono">{timeAgo(n.createdAt)}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}