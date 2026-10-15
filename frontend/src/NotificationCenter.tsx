import { useEffect, useRef, useState } from "react";
import type { TouchEvent, MouseEvent as ReactMouseEvent } from "react";
import { auth, db } from "./firebase";
import { collection, query, orderBy, onSnapshot, doc, updateDoc, addDoc, deleteDoc, writeBatch, limit } from "./database";
import { Bell, X, Receipt, Clock, AlertCircle, Sparkles, Trash2 } from "lucide-react";
import { toastSuccess } from "./notify";
import { safeChapaReceiptUrl } from "./utils/security";
import { notificationCacheKey } from "./utils/privateCache";

export interface AppNotification {
  id: string;
  type: "order_paid" | "order_placed" | "order_failed" | "promo" | "system";
  title: string;
  body: string;
  read: boolean;
  createdAt: number;
  orderId?: string;
  amount?: number;
  receiptUrl?: string;
  failureReason?: string;
}

export function getCachedNotifications(uid = auth.currentUser?.uid): AppNotification[] {
  if (typeof window === "undefined") return [];
  const key = notificationCacheKey(uid);
  if (!key || uid !== auth.currentUser?.uid) return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
  } catch {
    return [];
  }
}

export function saveCachedNotifications(items: AppNotification[], uid = auth.currentUser?.uid): void {
  if (typeof window === "undefined") return;
  const key = notificationCacheKey(uid);
  if (!key || uid !== auth.currentUser?.uid) return;
  try {
    localStorage.setItem(key, JSON.stringify(items.slice(0, 50)));
  } catch {}
}

export async function requestPushPermission(): Promise<NotificationPermission | null> {
  if (typeof window === "undefined" || !("Notification" in window)) return null;
  try {
    if (Notification.permission === "default") {
      return await Notification.requestPermission();
    }
    return Notification.permission;
  } catch {
    return null;
  }
}

export function sendBrowserNotification(title: string, body: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    try {
      new Notification(title, {
        body,
        icon: "/logo.png",
        badge: "/logo.png",
        tag: "restaurant-order"
      });
    } catch (e) {
      console.warn("[pushNotification] System notification dispatch note:", e);
    }
  }
}

export async function pushNotification(opts: {
  uid?: string | null;
  type: AppNotification["type"];
  title: string;
  body: string;
  orderId?: string;
  amount?: number;
  receiptUrl?: string;
  failureReason?: string;
}): Promise<void> {
  const targetUid = opts.uid || auth.currentUser?.uid;
  if (!targetUid || targetUid !== auth.currentUser?.uid) return;
  const notifId = `loc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const newNotif: AppNotification = {
    id: notifId,
    type: opts.type,
    title: opts.title,
    body: opts.body,
    read: false,
    createdAt: Date.now(),
    orderId: opts.orderId,
    amount: opts.amount,
    receiptUrl: opts.receiptUrl,
    failureReason: opts.failureReason
  };

  // 1. Immediately update local cache synchronously (0ms latency, works offline & across reloads)
  const current = getCachedNotifications();
  // Deduplicate exact order event within 15 minutes to prevent duplicates from multiple snapshot events
  const isDuplicate = current.some(
    n => n.orderId && n.orderId === opts.orderId && n.type === opts.type && (Date.now() - n.createdAt < 15 * 60 * 1000)
  );

  if (!isDuplicate) {
    const updated = [newNotif, ...current.filter(n => n.id !== notifId)].slice(0, 50);
    saveCachedNotifications(updated);

    // Notify UI components in memory immediately
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("savory_notification_update", { detail: { uid: targetUid, items: updated } }));
    }

    // 2. Fire browser OS Push Notification
    sendBrowserNotification(opts.title, opts.body);

    // 3. Fire in-app Corner Toast
    if (opts.type === "order_failed") {
      const { toastError } = await import("./notify");
      toastError(opts.title);
    } else {
      const { toastSuccess } = await import("./notify");
      toastSuccess(opts.title);
    }
  }

  // 4. Background cloud sync to the local database (fire-and-forget, never gates UI)
  if (targetUid === auth.currentUser?.uid) {
    addDoc(collection(db, "users", targetUid, "notifications"), {
      type: opts.type,
      title: opts.title,
      body: opts.body,
      read: false,
      createdAt: Date.now(),
      orderId: opts.orderId || null,
      amount: opts.amount || null,
      receiptUrl: opts.receiptUrl || null,
      failureReason: opts.failureReason || null
    }).catch(e => console.warn("[notifications] background cloud sync failed:", e));
  }
}

function NotificationRow({
  n,
  uid,
  onRead,
  onDismiss
}: {
  n: AppNotification;
  uid: string | null;
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
  key?: string;
}) {
  const [offsetX, setOffsetX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isHorizontalSwipe = useRef<boolean | null>(null);

  const handleTouchStart = (e: TouchEvent) => {
    startXRef.current = e.touches[0].clientX;
    startYRef.current = e.touches[0].clientY;
    isHorizontalSwipe.current = null;
    setIsSwiping(true);
  };

  const handleTouchMove = (e: TouchEvent) => {
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const dx = currentX - startXRef.current;
    const dy = currentY - startYRef.current;

    if (isHorizontalSwipe.current === null) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        isHorizontalSwipe.current = Math.abs(dx) > Math.abs(dy);
      }
    }

    if (isHorizontalSwipe.current) {
      setOffsetX(dx);
    }
  };

  const handleTouchEnd = () => {
    setIsSwiping(false);
    if (Math.abs(offsetX) > 90) {
      onDismiss(n.id);
    } else {
      setOffsetX(0);
    }
    isHorizontalSwipe.current = null;
  };

  return (
    <div className="relative overflow-hidden border-b border-stone-100 bg-rose-50 select-none">
      {/* Background trash action shown during swipe */}
      <div className="absolute inset-0 flex items-center justify-between px-4 text-rose-600">
        <Trash2 className="w-4 h-4" />
        <Trash2 className="w-4 h-4" />
      </div>

      {/* Swipeable Notification Item Card */}
      <div
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: isSwiping ? 'none' : 'transform 0.2s ease-out'
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('a')) {
            onRead(n.id);
          }
        }}
        className={`relative z-10 w-full text-left px-4 py-3 bg-white hover:bg-stone-50 transition-colors flex gap-3 cursor-pointer ${
          !n.read ? "bg-amber-50/40" : ""
        }`}
      >
        <div className="shrink-0 mt-0.5">
          {n.type === "order_paid" && <Receipt className="w-5 h-5 text-emerald-600" />}
          {n.type === "order_placed" && <Clock className="w-5 h-5 text-amber-600" />}
          {n.type === "order_failed" && <AlertCircle className="w-5 h-5 text-rose-600" />}
          {n.type === "promo" && <Sparkles className="w-5 h-5 text-purple-600" />}
          {n.type === "system" && <Bell className="w-5 h-5 text-stone-500" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="font-bold text-stone-900 text-sm truncate">{n.title}</p>
            <div className="flex items-center gap-1.5 shrink-0">
              {!n.read && <span className="w-2 h-2 rounded-full bg-amber-500" />}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDismiss(n.id);
                }}
                className="text-stone-300 hover:text-rose-500 p-0.5 transition-colors cursor-pointer"
                title="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <p className="text-xs text-stone-500 mt-0.5 line-clamp-2">{n.body}</p>
          {n.type === "order_paid" && safeChapaReceiptUrl(n.receiptUrl) && (
            <a
              href={safeChapaReceiptUrl(n.receiptUrl)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 hover:text-emerald-800 underline mt-1.5 cursor-pointer"
            >
              <Receipt className="w-3 h-3" />
              View Receipt ↗
            </a>
          )}
          {n.type === "order_failed" && n.failureReason && (
            <p className="text-[10px] text-rose-600 mt-1 font-mono font-medium">{n.failureReason}</p>
          )}
          <p className="text-[10px] text-stone-400 mt-1 font-mono">{timeAgo(n.createdAt)}</p>
        </div>
      </div>
    </div>
  );
}

export function NotificationCenter({ uid }: { uid: string | null }) {
  const [open, setOpen] = useState(false);
  // Instant synchronous initialization from local cache (0ms latency!)
  const [items, setItems] = useState<AppNotification[]>(() => getCachedNotifications(uid));
  const [unread, setUnread] = useState<number>(() => getCachedNotifications(uid).filter(n => !n.read).length);
  const [isLoading, setIsLoading] = useState<boolean>(() => getCachedNotifications(uid).length === 0 && !!uid);
  const ref = useRef<HTMLDivElement | null>(null);

  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );

  // Synchronous listener for local updates dispatched from anywhere in the app
  useEffect(() => {
    const handleLocalUpdate = (e: any) => {
      if (!uid || uid !== auth.currentUser?.uid || e.detail?.uid !== uid) return;
      const list: AppNotification[] = e.detail.items || getCachedNotifications(uid);
      setItems(list);
      setUnread(list.filter(n => !n.read).length);
      setIsLoading(false);
    };
    window.addEventListener("savory_notification_update", handleLocalUpdate);
    return () => window.removeEventListener("savory_notification_update", handleLocalUpdate);
  }, [uid]);

  // Live background subscription to the local database when uid is available
  useEffect(() => {
    const targetUid = uid;
    const cached = getCachedNotifications(uid);
    setItems(cached);
    setUnread(cached.filter(n => !n.read).length);
    setOpen(false);
    if (!targetUid || targetUid !== auth.currentUser?.uid) {
      setIsLoading(false);
      return;
    }

    const q = query(
      collection(db, "users", targetUid, "notifications"),
      orderBy("createdAt", "desc"),
      limit(25)
    );

    const unsub = onSnapshot(q, (snap) => {
      if (targetUid !== auth.currentUser?.uid) return;
      const cloudList = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as AppNotification));
      // Reconcile cloud items with local items so newly-pushed local items are never wiped out
      const currentLocal = getCachedNotifications(targetUid);
      const localOnly = currentLocal.filter(l => !cloudList.some(c => (c.orderId && c.orderId === l.orderId && c.type === l.type) || c.id === l.id));
      const merged = [...localOnly, ...cloudList].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
      saveCachedNotifications(merged, targetUid);
      setItems(merged);
      setUnread(merged.filter(n => !n.read).length);
      setIsLoading(false);
    }, (err) => {
      console.warn("[notifications] snapshot error:", err?.message);
      setIsLoading(false);
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
    if (!uid || uid !== auth.currentUser?.uid) return;
    const updated = items.map(n => ({ ...n, read: true }));
    saveCachedNotifications(updated, uid);
    setItems(updated);
    setUnread(0);

    const targetUid = uid;
    if (!targetUid) return;
    const unreadDocs = items.filter(n => !n.read && !n.id.startsWith('loc-')).map(n => doc(db, "users", targetUid, "notifications", n.id));
    if (unreadDocs.length === 0) return;
    const batch = writeBatch(db);
    unreadDocs.forEach(d => batch.update(d, { read: true }));
    try { await batch.commit(); } catch (e) { console.warn(e); }
  };

  const markRead = async (id: string) => {
    if (!uid || uid !== auth.currentUser?.uid) return;
    const updated = items.map(n => n.id === id ? { ...n, read: true } : n);
    saveCachedNotifications(updated, uid);
    setItems(updated);
    setUnread(updated.filter(n => !n.read).length);

    const targetUid = uid;
    if (!targetUid || id.startsWith("loc-")) return;
    try { await updateDoc(doc(db, "users", targetUid, "notifications", id), { read: true }); } catch {}
  };

  const dismissNotification = async (id: string) => {
    if (!uid || uid !== auth.currentUser?.uid) return;
    const updated = items.filter(n => n.id !== id);
    saveCachedNotifications(updated, uid);
    setItems(updated);
    setUnread(updated.filter(n => !n.read).length);

    const targetUid = uid;
    if (!targetUid || id.startsWith("loc-")) return;
    try {
      await deleteDoc(doc(db, "users", targetUid, "notifications", id));
    } catch (e) {
      console.warn("Failed to delete notification doc:", e);
    }
  };

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
        <div className="fixed inset-x-4 top-20 w-auto max-h-[calc(100dvh-6rem)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 sm:max-h-none bg-white border border-stone-200 rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-600" />
              <span className="font-bold text-stone-900 text-sm">Notifications</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline text-[10px] text-stone-400">Swipe to dismiss</span>
              <button onClick={() => setOpen(false)} className="text-stone-400 hover:text-stone-700 p-1 rounded cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {uid && pushPermission === "default" && (
            <button
              onClick={async () => setPushPermission((await requestPushPermission()) || "unsupported")}
              className="w-full px-4 py-2 text-left text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100"
            >Enable order notifications
            </button>
          )}

          <div className="max-h-[calc(100dvh-10rem)] sm:max-h-96 overflow-y-auto">
            {isLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className="animate-pulse flex items-start gap-3 p-3 bg-stone-50 rounded-xl border border-stone-100">
                    <div className="w-8 h-8 rounded-full bg-stone-200 flex-shrink-0" />
                    <div className="flex-1 space-y-2 py-0.5">
                      <div className="h-3 bg-stone-200 rounded w-2/3" />
                      <div className="h-2.5 bg-stone-200 rounded w-5/6" />
                    </div>
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-10 text-center text-stone-400 text-sm">
                <Bell className="w-8 h-8 mx-auto mb-2 text-stone-300" />
                No notifications yet — your order updates will appear here.
              </div>
            ) : (
              items.map(n => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  uid={uid}
                  onRead={markRead}
                  onDismiss={dismissNotification}
                />
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
