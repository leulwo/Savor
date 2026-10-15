/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Routes, Route, useNavigate, useParams, Link, useLocation } from "react-router-dom";
import { MenuItem, MenuItemVariation, Order, OrderItem } from "./types";

const AdminPortal = React.lazy(() => import("./AdminPortal"));
import {
  Utensils,
  ShoppingCart,
  X,
  CheckCircle,
  ChevronRight,
  ClipboardList,
  Trash2,
  Lock,
  Clock,
  Settings,
  Star,
  Search,
  LogIn,
  LogOut,
  User,
  RotateCcw,
  ChevronDown,
  Truck,
  Heart,
  CalendarDays,
  Store,
  ShoppingBag,
  Mail,
  Phone,
  MapPin,
  AlertCircle,
  Loader2,
  Plus,
  Minus,
  Banknote,
  ReceiptText,
  ExternalLink,
  CircleX
} from "lucide-react";
import {
  auth,
  authedFetch,
  completeGoogleSignIn,
  db,
  googleSignInErrorMessage,
  hasPendingGoogleRedirect,
  onAuthStateChanged,
  signInWithGoogle,
  signOut
} from "./firebase";
import { collection, onSnapshot, doc, query, where, setDoc, getDoc, orderBy, limit } from "./database";
import { APIProvider } from "@vis.gl/react-google-maps";
import GoogleMapsAddressInput from "./GoogleMapsAddressInput";
import Chatbot from "./components/Chatbot";
import ClassicalMenuFrame from "./components/ClassicalMenuFrame";
import ReceiptQrCode from "./components/ReceiptQrCode";
import ItemReviews from "./components/ItemReviews";
import { confirmDialog, toastError, toastSuccess, toastInfo, toastWarning } from "./notify";
import { NotificationCenter, pushNotification } from "./NotificationCenter";
import { normalizeGalleryImages } from "./utils/galleries";
import { parseHHMMToMinutes, scheduleAccepts, formatTimeHHMM } from "./utils/schedule";
import { getRestaurantName } from "./utils/businessName";
import { getUnavailableCartItems } from "./utils/cartAvailability";
import { safeChapaCheckoutUrl, safeHttpsUrl } from "./utils/security";
import { clearPrivateBrowserCache } from "./utils/privateCache";
import { normalizeUserProfile } from "./utils/displayData";
// @ts-ignore
import chapaLogoImg from "./images.png";

const API_KEY = process.env.GOOGLE_MAPS_PLATFORM_KEY || (import.meta as any).env?.VITE_GOOGLE_MAPS_PLATFORM_KEY || "";

// Recursively removes undefined values so database setDoc/updateDoc never rejects them.
function sanitizeForDatabase<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(v => sanitizeForDatabase(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        clean[key] = sanitizeForDatabase(v);
      }
    }
    return clean as T;
  }
  return value;
}

function formatCheckoutError(value: unknown): string {
  if (typeof value === "string") return value.trim() || "Checkout could not be completed. Please try again.";
  if (value && typeof value === "object") {
    const item = value as any;
    if (typeof item.error === "string" && item.error.trim()) return item.error;
    if (typeof item.message === "string" && item.message.trim()) return item.message;
    if (typeof item.code === "string" && item.code === "AUTH_SESSION_EXPIRED") return "Your sign-in session expired. Sign in again to continue.";
  }
  return "Checkout could not be completed. Please try again.";
}

function checkoutCartSignature(items: unknown): string | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const lines = items.map((entry: any) => {
    const menuItem = entry?.menuItem || entry;
    const id = String(menuItem?.id || menuItem?.menuItemId || entry?.menuItemId || "");
    const quantity = Number(entry?.quantity);
    const variationId = String(entry?.variationId ?? menuItem?.variation?.id ?? "");
    return id && Number.isInteger(quantity) && quantity > 0 ? { id, variationId, quantity } : null;
  });
  if (lines.some(line => line === null)) return null;
  return JSON.stringify((lines as { id: string; variationId: string; quantity: number }[]).sort((a, b) =>
    `${a.id}:${a.variationId}:${a.quantity}`.localeCompare(`${b.id}:${b.variationId}:${b.quantity}`)
  ));
}

function cartMatchesOrder(currentItems: unknown, orderItems: unknown): boolean {
  const current = checkoutCartSignature(currentItems);
  return current !== null && current === checkoutCartSignature(orderItems);
}

// ---- Product variations (e.g. drink sizes) ----
function itemVariations(item: MenuItem): MenuItemVariation[] {
  return Array.isArray(item.variations) ? item.variations.filter(v => v && typeof v === "object") : [];
}
function isVariationAvailable(v: MenuItemVariation): boolean {
  return v.isAvailable !== false;
}
function variationPrice(v: MenuItemVariation): number {
  const p = Number(v?.price);
  return isFinite(p) && p >= 0 ? p : 0;
}
function menuDisplayPrice(item: MenuItem): string {
  const vs = itemVariations(item);
  if (vs.length === 0) {
    return `${(Number(item.price) || 0).toFixed(2)} ETB`;
  }
  // The marked default (main) variation is the headline product when available.
  const def = vs.find(v => v.isDefault);
  if (def && isVariationAvailable(def)) {
    return `${variationPrice(def).toFixed(2)} ETB`;
  }
  const available = vs.filter(isVariationAvailable);
  if (available.length === 0) return "Unavailable";
  return `From ${Math.min(...available.map(variationPrice)).toFixed(2)} ETB`;
}

// ---- Operating schedule ----
// Schedule helpers (parseHHMMToMinutes, scheduleAccepts, formatTimeHHMM) live in utils/schedule.ts.

// Helper functions for date categorization
export const getLocalDateString = (dateStr: string) => {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "Unknown Date";

    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (d.toDateString() === today.toDateString()) {
      return "Today";
    } else if (d.toDateString() === yesterday.toDateString()) {
      return "Yesterday";
    } else {
      return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
  } catch (e) {
    return "Unknown Date";
  }
};

export const ChapaLogoSVG = ({ className = "w-6 h-6" }: { className?: string }) => {
  return (
    <img
      src={chapaLogoImg}
      className={`${className} object-contain mix-blend-multiply`}
      alt="Online payment"
      referrerPolicy="no-referrer"
    />
  );
};

export const groupOrdersByDate = (ordersList: Order[]) => {
  const groups: { [key: string]: Order[] } = {};
  ordersList.forEach(order => {
    const key = getLocalDateString(order.createdAt);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(order);
  });
  return groups;
};

export function MainApp() {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [isMenuLoading, setIsMenuLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Auth state
  const [user, setUser] = useState<any>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Categories state
  const [categories, setCategories] = useState<{ id: string, name: string }[]>([]);

  // My Orders
  const [isMyOrdersOpen, setIsMyOrdersOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [myOrders, setMyOrders] = useState<Order[]>([]);
  const [isMyOrdersLoading, setIsMyOrdersLoading] = useState(true);
  const [expandedMyOrderId, setExpandedMyOrderId] = useState<string | null>(null);
  const [orderActionModal, setOrderActionModal] = useState<Order | null>(null);

  // Cart state
  const [cart, setCart] = useState<OrderItem[]>(() => {
    try {
      const saved = localStorage.getItem("gourmet_cart");
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [cartLoadedFromDb, setCartLoadedFromDb] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);

  // Reservation state
  const [isReservationOpen, setIsReservationOpen] = useState(false);
  const [reservationForm, setReservationForm] = useState({
    date: "",
    time: "19:00",
    partySize: 2,
    notes: ""
  });
  const [isSubmittingReservation, setIsSubmittingReservation] = useState(false);

  // Checkout Form State
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [customerName, setCustomerName] = useState(() => localStorage.getItem("lastCheckoutName") || "");
  const [customerEmail, setCustomerEmail] = useState(() => localStorage.getItem("lastCheckoutEmail") || "");
  const [customerPhone, setCustomerPhone] = useState(() => localStorage.getItem("lastCheckoutPhone") || "");
  const [blockNumber, setBlockNumber] = useState(() => localStorage.getItem("lastCheckoutBlock") || "");
  const [roomNumber, setRoomNumber] = useState(() => localStorage.getItem("lastCheckoutRoom") || "");
  const [googleMapsAddress, setGoogleMapsAddress] = useState(() => localStorage.getItem("lastCheckoutAddress") || "");
  const [useGoogleMaps, setUseGoogleMaps] = useState(() => localStorage.getItem("lastCheckoutUseGoogleMaps") === "true");
  const [specialInstructions, setSpecialInstructions] = useState(() => localStorage.getItem("lastCheckoutSpecialInstructions") || "");
  const [subscribeNewsletter, setSubscribeNewsletter] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState<'chapa' | 'cash'>('chapa');
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutPhoneError, setCheckoutPhoneError] = useState<string | null>(null);
  const checkoutPhoneInput = useRef<HTMLInputElement>(null);
  const [fulfillmentType, setFulfillmentType] = useState<'delivery' | 'pickup' | 'dineIn'>('delivery');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<string>("");

  // Promo Code State
  const [promoCodeInput, setPromoCodeInput] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<any>(null);
  const [promoError, setPromoError] = useState("");

  const [expandedProduct, setExpandedProduct] = useState<MenuItem | null>(null);
  const [expandedQuantity, setExpandedQuantity] = useState(1);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [expandedVariationId, setExpandedVariationId] = useState<string | null>(null);

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const match = location.pathname.match(/^\/food\/(.+)/);
    if (match) {
      const food = menu.find(item => item.id === match[1]);
      if (food) {
        setExpandedProduct(food);
        setExpandedQuantity(1);
        setActiveImageIndex(0);
        const vs = itemVariations(food);
        const preselect = vs.find(v => v.isDefault && isVariationAvailable(v)) || vs.find(isVariationAvailable);
        setExpandedVariationId(preselect ? String(preselect.id) : null);
      }
    } else if (expandedProduct && location.pathname === "/") {
      setExpandedProduct(null);
    }
  }, [location.pathname, menu]);

  const handleCloseProductModal = () => {
    setExpandedProduct(null);
    setExpandedVariationId(null);
    navigate("/");
  };

  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<Order | null>(null);
  const [chapaCheckoutUrl, setChapaCheckoutUrl] = useState<string | null>(() => localStorage.getItem('chapaCheckoutUrl'));
  const [hasShownOrderModal, setHasShownOrderModal] = useState<string | null>(() => localStorage.getItem('shownOrderModalId'));
  const [checkoutSettings, setCheckoutSettings] = useState({
    serviceTaxPercent: 15,
    flatFeeETB: 0,
    isOpen: true,
    scheduleEnabled: false,
    openTime: "09:00",
    closeTime: "22:00",
    enableCOD: true,
    prepTimeMinutes: 30,
    scheduledStepsMinutes: 15
  });
  const [now, setNow] = useState(() => new Date());
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [globalSettings, setGlobalSettings] = useState<any>(null);
  // Keep the brand area quiet until saved settings load; the generic fallback
  // briefly flashed as the business name on every cold page load.
  const businessName = typeof globalSettings?.restaurantName === "string"
    ? globalSettings.restaurantName.trim()
    : "";
  const [subscribeEmail, setSubscribeEmail] = useState("");
  const [subscribeStatus, setSubscribeStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [subscribeErrorMsg, setSubscribeErrorMsg] = useState("");

  const handleSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subscribeEmail) return;
    setSubscribeStatus("loading");
    setSubscribeErrorMsg("");
    try {
      const response = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: subscribeEmail })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to subscribe");
      setSubscribeStatus("success");
      setSubscribeEmail("");
      setTimeout(() => setSubscribeStatus("idle"), 3000);
    } catch (error: any) {
      console.error("Subscription failed:", error);
      setSubscribeStatus("error");
      setSubscribeErrorMsg(error.message || "Subscription failed. Please try again.");
    }
  };

  useEffect(() => {
    let cancelled = false;

    // Instant local listener for global restaurant branding settings
    const unsubscribeGlobal = onSnapshot(doc(db, "settings", "global"), (docSnap) => {
      if (!cancelled && docSnap.exists()) {
        setGlobalSettings(docSnap.data());
      }
    }, (error) => {
      console.warn("Global settings listener note:", error?.message);
    });

    // Instant local listener for checkout & operating schedule settings (No slow /api/settings fetch!)
    const unsubscribeCheckout = onSnapshot(doc(db, "settings", "checkout"), (docSnap) => {
      if (!cancelled && docSnap.exists()) {
        const data = docSnap.data();
        setCheckoutSettings({
          serviceTaxPercent: data.serviceTaxPercent ?? 15,
          flatFeeETB: data.flatFeeETB ?? 0,
          isOpen: data.isOpen ?? true,
          scheduleEnabled: data.scheduleEnabled ?? false,
          openTime: data.openTime ?? "09:00",
          closeTime: data.closeTime ?? "22:00",
          enableCOD: data.enableCOD ?? true,
          prepTimeMinutes: data.prepTimeMinutes ?? 30,
          scheduledStepsMinutes: data.scheduledStepsMinutes ?? 15
        });
        setSettingsLoaded(true);
      } else if (!cancelled && !settingsLoaded) {
        setSettingsLoaded(true);
      }
    }, (error) => {
      console.warn("Checkout settings listener note:", error?.message);
      if (!cancelled && !settingsLoaded) setSettingsLoaded(true);
    });

    return () => {
      cancelled = true;
      unsubscribeGlobal();
      unsubscribeCheckout();
    };
  }, []);

  // Keep schedule-based availability fresh; re-check every 30s.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const scheduleStatus = scheduleAccepts(checkoutSettings, now);
  // Treat as open until real settings arrive so the closed banner/buttons never flash during load.
  const isOpen = !settingsLoaded ? true : (checkoutSettings.scheduleEnabled ? scheduleStatus.accepting : !!checkoutSettings.isOpen);

  const [activeOrderId, setActiveOrderId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const txRef = params.get('tx_ref');
    if (txRef) {
      localStorage.setItem('activeOrderId', txRef);
      return txRef;
    }
    return localStorage.getItem('activeOrderId');
  });
  const [isOrderModalOpen, setIsOrderModalOpen] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('tx_ref') || params.has('status') || params.has('payment_return') || !!localStorage.getItem('activeOrderId');
  });
  const [isVerifying, setIsVerifying] = useState(false);
  const [paymentVerificationResult, setPaymentVerificationResult] = useState<'verifying' | 'success' | 'failed' | 'pending' | null>(null);

  const clearCartAfterVerifiedPayment = useCallback(async (orderId: string, ownerUid?: string) => {
    // Guard against later snapshot updates clearing a new cart after the customer starts another order.
    if (localStorage.getItem("gourmet_cart_cleared_order") === orderId) return;
    const clearedAt = Date.now();
    localStorage.setItem("gourmet_cart_cleared_order", orderId);
    localStorage.setItem("gourmet_cart_cleared_at", String(clearedAt));
    localStorage.setItem("gourmet_cart", "[]");
    localStorage.removeItem("gourmet_cart_backup");
    setCart([]);
    if (ownerUid) {
      try {
        await setDoc(doc(db, "carts", ownerUid), {
          items: [],
          updatedAt: new Date(clearedAt).toISOString(),
          clearedByPaidOrderId: orderId
        }, { merge: true });
      } catch (error) {
        console.warn("Could not sync the cleared cart to the local database yet:", error);
      }
    }
  }, []);

  const restoreCartForFailedPayment = useCallback(async (order: any, ownerUid?: string) => {
    let items: OrderItem[] = Array.isArray(order?.items) ? order.items : [];
    if (!items.length) {
      try {
        const backup = localStorage.getItem("gourmet_cart_backup");
        items = backup ? JSON.parse(backup) : [];
      } catch { items = []; }
    }
    if (!items.length) return;
    setCart(items);
    localStorage.setItem("gourmet_cart", JSON.stringify(items));
    if (ownerUid) {
      try {
        await setDoc(doc(db, "carts", ownerUid), { items: sanitizeForDatabase(items), updatedAt: new Date().toISOString() }, { merge: true });
      } catch (error) {
        console.warn("Could not sync the restored cart to the local database yet:", error);
      }
    }
  }, []);

  const verifyChapaPayment = useCallback(async (targetId: string, autoPoll = false, referenceQuery = "") => {
    const ownerUid = user?.uid;
    if (!targetId || !ownerUid || auth.currentUser?.uid !== ownerUid) return;
    setIsVerifying(true);
    setPaymentVerificationResult("verifying");
    const delays = autoPoll ? [0, 2000, 5000, 10000, 20000, 30000, 60000] : [0];
    try {
      let finalStatus = "pending";
      let finalOrder: any = null;
      for (const delay of delays) {
        if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
        if (auth.currentUser?.uid !== ownerUid) return;
        try {
          const response = await authedFetch(`/api/chapa/verify/${encodeURIComponent(targetId)}${delay === 0 ? referenceQuery : ""}`);
          const data = await response.json().catch(() => ({}));
          if (auth.currentUser?.uid !== ownerUid) return;
          finalOrder = data.order || finalOrder;
          if (data.status === "completed" || data.status === "success") {
            finalStatus = "completed";
            break;
          }
          const needsReconciliation = data.paymentReconciliationRequired === true || data.order?.paymentReconciliationRequired === true || data.status === "reconciling";
          if (needsReconciliation) {
            localStorage.setItem("chapaReconciliationOrderId", targetId);
            finalStatus = "reconciling";
            continue;
          }
          if (data.code === "PAYMENT_DETAILS_MISMATCH") {
            localStorage.setItem("chapaReconciliationOrderId", targetId);
            finalStatus = "reconciling";
            break;
          }
          const definitiveFailure = data.failureDefinitive === true || data.order?.failureDefinitive === true || data.order?.status === "cancelled";
          if (definitiveFailure) {
            finalStatus = "failed";
            break;
          }
          finalStatus = "pending";
        } catch (error: any) {
          if (error?.code === "AUTH_SESSION_EXPIRED") break;
          finalStatus = "pending";
        }
      }
      if (finalStatus === "completed") {
        if (localStorage.getItem("chapaReconciliationOrderId") === targetId) localStorage.removeItem("chapaReconciliationOrderId");
        setPaymentVerificationResult("success");
        await clearCartAfterVerifiedPayment(targetId, user?.uid || finalOrder?.userId || localStorage.getItem("lastAuthUid") || undefined);
      } else if (finalStatus === "failed") {
        if (localStorage.getItem("chapaReconciliationOrderId") === targetId) localStorage.removeItem("chapaReconciliationOrderId");
        setPaymentVerificationResult("failed");
        await restoreCartForFailedPayment(finalOrder, user?.uid || finalOrder?.userId || localStorage.getItem("lastAuthUid") || undefined);
      } else {
        setPaymentVerificationResult("pending");
      }
    } finally {
      setIsVerifying(false);
    }
  }, [clearCartAfterVerifiedPayment, restoreCartForFailedPayment, user?.uid]);

  useEffect(() => {
    const redirectWasPending = hasPendingGoogleRedirect();
    void completeGoogleSignIn()
      .catch((error) => {
        console.error("Google redirect sign-in failed", error);
        setLoginError(googleSignInErrorMessage(error));
      })
      .finally(() => setAuthLoading(false));

    // Auth Listener
    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      const previousUid = localStorage.getItem('lastAuthUid');
      if (previousUid && previousUid !== (currentUser?.uid ?? null)) {
        clearPrivateBrowserCache(localStorage);
        setCartLoadedFromDb(false);
        setCart([]);
        setUserProfile(null);
        setMyOrders([]);
        setPlacedOrder(null);
        setActiveOrderId(null);
        setChapaCheckoutUrl(null);
        setIsOrderModalOpen(false);
        setOrderActionModal(null);
        setIsMyOrdersOpen(false);
        setCustomerName('');
        setCustomerEmail('');
        setCustomerPhone('');
        setBlockNumber('');
        setRoomNumber('');
        setGoogleMapsAddress('');
        setUseGoogleMaps(false);
        setSpecialInstructions('');
      }
      setUser(currentUser);
      if (currentUser || !redirectWasPending) {
        setAuthLoading(false);
      }
      if (currentUser) {
        localStorage.setItem("lastAuthUid", currentUser.uid);
        if (!localStorage.getItem("lastCheckoutName")) {
          setCustomerName(currentUser.displayName || "");
        }
        if (!localStorage.getItem("lastCheckoutEmail")) {
          setCustomerEmail(currentUser.email || "");
        }

        try {
          const userDocRef = doc(db, "users", currentUser.uid);
          const userDocSnap = await getDoc(userDocRef);
          if (auth.currentUser?.uid !== currentUser.uid) return;

          if (!userDocSnap.exists()) {
            const newProfile = {
              uid: currentUser.uid,
              email: currentUser.email || "",
              displayName: currentUser.displayName || "",
              savedAddresses: [],
              favoriteItems: [],
              createdAt: new Date().toISOString()
            };
            await setDoc(userDocRef, newProfile);
            if (auth.currentUser?.uid !== currentUser.uid) return;
            setUserProfile(newProfile);
          } else {
            setUserProfile(normalizeUserProfile(userDocSnap.data(), currentUser.uid));
          }
        } catch (error) {
          console.error("Error loading user profile:", error);
        }

        try {
          const cartDoc = await getDoc(doc(db, "carts", currentUser.uid));
          if (auth.currentUser?.uid !== currentUser.uid) return;
          if (cartDoc.exists()) {
            const savedCart = cartDoc.data();
            const paidClearAt = Number(localStorage.getItem("gourmet_cart_cleared_at") || 0);
            const cloudUpdatedAt = Date.parse(String(savedCart.updatedAt || ""));
            const cloudCartPredatesPaidOrder = paidClearAt > 0 && (!Number.isFinite(cloudUpdatedAt) || cloudUpdatedAt <= paidClearAt);
            if (!cloudCartPredatesPaidOrder) {
              const dbCart = savedCart.items || [];
              setCart(prevCart => {
                const merged = [...prevCart];
                dbCart.forEach((dbItem: OrderItem) => {
                  const existingIndex = merged.findIndex(item => item.menuItem.id === dbItem.menuItem.id);
                  if (existingIndex > -1) {
                    merged[existingIndex].quantity = Math.max(merged[existingIndex].quantity, dbItem.quantity);
                  } else {
                    merged.push(dbItem);
                  }
                });
                return merged;
              });
            }
          }
        } catch (error) {
          console.error("Error loading cart from db:", error);
        }
        if (auth.currentUser?.uid === currentUser.uid) setCartLoadedFromDb(true);
      } else {
        setCartLoadedFromDb(false);
      }
    });

    // Real-time Categories Listener (client-side sort ensures fast load with no index requirements)
    const unsubscribeCategories = onSnapshot(collection(db, "categories"), (snapshot) => {
      const catData = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as { id: string, name: string, sortOrder?: number }))
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      setCategories(catData);
    }, (error) => {
      console.error("Failed to sync categories", error);
    });

    // Real-time Menu Listener (all items fetched instantly, client filters active/variations)
    const unsubscribeMenu = onSnapshot(collection(db, "menu"), (snapshot) => {
      const menuData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem));
      setMenu(menuData);
      setIsMenuLoading(false);
    }, (error) => {
      console.error("Failed to sync menu state", error);
      setIsMenuLoading(false);
    });

    return () => {
      unsubscribeAuth();
      unsubscribeMenu();
      unsubscribeCategories();
    };
  }, []);

  useEffect(() => {
    // 1. Always update local storage
    try {
      localStorage.setItem("gourmet_cart", JSON.stringify(cart));
    } catch (e) {
      console.error("Failed to write cart to local storage", e);
    }

    // 2. If user is logged in AND their cloud cart has been loaded/merged, sync to the local database
    if (user && cartLoadedFromDb) {
      setDoc(doc(db, "carts", user.uid), {
        items: sanitizeForDatabase(cart),
        updatedAt: new Date().toISOString()
      }, { merge: true })
        .catch(e => {
          console.error("Failed to sync cart to database", e);
        });
    }
  }, [cart, user, cartLoadedFromDb]);

  useEffect(() => {
    if (!user) {
      setMyOrders([]);
      setIsMyOrdersLoading(false);
      return;
    }
    setIsMyOrdersLoading(true);
    // Listen to user's orders (fetch simply by userId and sort in JS, avoiding missing index errors)
    const q = query(
      collection(db, "orders"),
      where("userId", "==", user.uid)
    );

    const unsubscribeMyOrders = onSnapshot(q, (snapshot) => {
      const userOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Order));
      userOrders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setMyOrders(userOrders);
      setIsMyOrdersLoading(false);
    }, (err) => {
      console.warn("My orders listener note:", err?.message);
      setIsMyOrdersLoading(false);
    });
    return () => unsubscribeMyOrders();
  }, [user]);

  useEffect(() => {
    if (!activeOrderId) {
      setPlacedOrder(null);
      return;
    }

    // Treat every return URL as a prompt to verify; query-string status is never proof of payment.
    const params = new URLSearchParams(window.location.search);
    const hasReturnSignal = params.has("tx_ref") || params.has("payment_return") || params.has("status");
    if (hasReturnSignal && user) {
      // Wait for Firebase auth before consuming the return URL or verifying an owner-only order.
      setIsOrderModalOpen(true);
      window.history.replaceState({}, document.title, window.location.pathname);
      setIsVerifying(true);
      setPaymentVerificationResult("verifying");
      const chapaReference = params.get("chapa_reference") || params.get("reference");
      const referenceQuery = chapaReference ? "?reference=" + encodeURIComponent(chapaReference) : "";
      void verifyChapaPayment(activeOrderId, true, referenceQuery);
    } else if (user && localStorage.getItem("activeOrderId") === activeOrderId) {
      // Recover an unresolved return after a refresh, even after the callback query was removed.
      setIsOrderModalOpen(true);
      void verifyChapaPayment(activeOrderId, true);
    }

    const unsubscribeOrder = onSnapshot(doc(db, "orders", activeOrderId), (docSnap) => {
      if (docSnap.exists()) {
        const orderData = { id: docSnap.id, ...docSnap.data() } as Order;
        setPlacedOrder(orderData);
        
        if (orderData.paymentStatus === 'completed') {
          setPaymentVerificationResult('success');
          if (localStorage.getItem("chapaReconciliationOrderId") === docSnap.id) localStorage.removeItem("chapaReconciliationOrderId");
          void clearCartAfterVerifiedPayment(docSnap.id, user?.uid || orderData.userId || localStorage.getItem("lastAuthUid") || undefined).catch(error => {
            console.warn("Could not sync cleared paid cart yet:", error);
          });
          setChapaCheckoutUrl(null);
          localStorage.removeItem('chapaCheckoutUrl');
          const receiptUrl = orderData.receipt?.reference
            ? `https://chapa.link/payment-receipt/${orderData.receipt.reference}`
            : undefined;
          const targetUid = user?.uid || orderData.userId || (typeof window !== "undefined" ? localStorage.getItem("lastAuthUid") : null);
          pushNotification({
            uid: targetUid,
            type: "order_paid",
            title: "Payment successful!",
            body: `Payment succeeded! Thanks for ordering from ${globalSettings?.restaurantName || 'us'}! Your order #${docSnap.id.slice(-8).toUpperCase()} for ${(orderData.total ?? 0).toFixed(2)} ETB is being prepared.`,
            orderId: docSnap.id,
            amount: orderData.total,
            receiptUrl: receiptUrl
          }).catch(() => {});
        } else if (orderData.failureDefinitive === true || orderData.paymentAttemptStatus === 'cancelled' || orderData.paymentStatus === 'failed' || orderData.status === 'cancelled') {
          setPaymentVerificationResult('failed');
          if (localStorage.getItem("chapaReconciliationOrderId") === docSnap.id) localStorage.removeItem("chapaReconciliationOrderId");
          void restoreCartForFailedPayment(orderData, user?.uid || orderData.userId || localStorage.getItem("lastAuthUid") || undefined).catch(error => {
            console.warn("Could not sync restored failed-payment cart yet:", error);
          });
          const targetUid = user?.uid || orderData.userId || (typeof window !== "undefined" ? localStorage.getItem("lastAuthUid") : null);
          pushNotification({
            uid: targetUid,
            type: "order_failed",
            title: "Payment failed",
            body: `Payment failed or cancelled for order #${docSnap.id.slice(-8).toUpperCase()}. ${orderData.failureReason || 'Your cart items have been restored.'}`,
            orderId: docSnap.id,
            amount: orderData.total,
            failureReason: orderData.failureReason
          }).catch(() => {});
        }
      } else {
        console.log("[ORDER SNAPSHOT] Order doc not present yet for activeOrderId:", activeOrderId);
      }
    });

    return () => unsubscribeOrder();
  }, [activeOrderId, user?.uid, verifyChapaPayment, clearCartAfterVerifiedPayment, restoreCartForFailedPayment]);

  const handleLogin = async () => {
    if (loginLoading) return;
    setLoginLoading(true);
    setLoginError(null);
    try {
      await signInWithGoogle();
    } catch (error: any) {
      console.error("Login failed", error);
      setLoginError(googleSignInErrorMessage(error));
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed", error);
    }
  };

  const handleToggleFavorite = async (itemId: string) => {
    if (!user || !userProfile) {
      toastInfo("Please log in to save your favorite dishes.");
      return;
    }

    try {
      const isFavorite = userProfile.favoriteItems?.includes(itemId);
      const newFavorites = isFavorite
        ? userProfile.favoriteItems.filter((id: string) => id !== itemId)
        : [...(userProfile.favoriteItems || []), itemId];

      await setDoc(doc(db, "users", user.uid), {
        favoriteItems: newFavorites
      }, { merge: true });

      setUserProfile((prev: any) => ({ ...prev, favoriteItems: newFavorites }));
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
    }
  };

  const handleReservationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toastInfo("Please sign in to make a reservation.");
      return;
    }

    setIsSubmittingReservation(true);
    try {
      const reservation = {
        userId: user.uid,
        customerName: user.displayName || customerName,
        customerEmail: user.email || customerEmail,
        customerPhone: customerPhone,
        date: reservationForm.date,
        time: reservationForm.time,
        partySize: reservationForm.partySize,
        notes: reservationForm.notes,
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      const resRef = doc(collection(db, "reservations"));
      await setDoc(resRef, reservation);

      toastSuccess("Reservation requested successfully! We will confirm shortly.");
      setIsReservationOpen(false);
      setReservationForm({ date: "", time: "19:00", partySize: 2 });
    } catch (error) {
      console.error("Reservation failed:", error);
      toastError("Failed to submit reservation. Please try again.");
    } finally {
      setIsSubmittingReservation(false);
    }
  };

  const addToCart = (item: MenuItem, variation?: MenuItemVariation) => {
    const variationId = variation ? String(variation.id) : null;
    const unitPrice = variation ? variationPrice(variation) : (Number(item.price) || 0);
    const snapshot: OrderItem["menuItem"] = {
      ...item,
      price: unitPrice,
      ...(variation ? { variation: { id: String(variation.id), label: variation.label || "" } } : {})
    };
    setCart(prev => {
      const existing = prev.find(i => i.menuItem.id === item.id && (i.variationId ?? null) === (variationId ?? null));
      if (existing) {
        return prev.map(i =>
          (i.menuItem.id === item.id && (i.variationId ?? null) === (variationId ?? null))
            ? { ...i, quantity: i.quantity + 1 }
            : i
        );
      }
      return [...prev, { menuItem: snapshot, quantity: 1, variationId }];
    });
    // Removed automatic cart sidebar popup to wait until user clicks explicitly
  };

  const updateCartQuantity = (itemId: string, variationId: string | null | undefined, delta: number) => {
    setCart(prev => {
      return prev.map(i => {
        if (i.menuItem.id === itemId && (i.variationId ?? null) === (variationId ?? null)) {
          const nextQty = i.quantity + delta;
          return nextQty > 0 ? { ...i, quantity: nextQty } : i;
        }
        return i;
      }).filter(i => i.quantity > 0);
    });
  };

  const removeFromCart = (itemId: string, variationId?: string | null) => {
    setCart(prev => prev.filter(i => !(i.menuItem.id === itemId && (i.variationId ?? null) === (variationId ?? null))));
  };

  const cartTotal = useMemo(() => cart.reduce((acc, item) => acc + (item.menuItem.price * item.quantity), 0), [cart]);
  const taxAmount = useMemo(() => cartTotal * (checkoutSettings.serviceTaxPercent / 100), [cartTotal, checkoutSettings.serviceTaxPercent]);

  const discountAmount = useMemo(() => {
    if (!appliedPromo) return 0;
    if (appliedPromo.type === 'percentage') {
      let disc = cartTotal * (appliedPromo.value / 100);
      if (appliedPromo.maxDiscount) {
        disc = Math.min(disc, appliedPromo.maxDiscount);
      }
      return disc;
    }
    return appliedPromo.value;
  }, [appliedPromo, cartTotal]);

  const deliveryFee = useMemo(() => fulfillmentType === 'delivery' ? checkoutSettings.flatFeeETB : 0, [fulfillmentType, checkoutSettings.flatFeeETB]);
  const finalTotal = useMemo(() => Math.max(0, cartTotal + taxAmount + deliveryFee - discountAmount), [cartTotal, taxAmount, deliveryFee, discountAmount]);
  const unavailableCartItems = useMemo(() => isMenuLoading ? [] : getUnavailableCartItems(cart, menu), [cart, menu, isMenuLoading]);

  const handleApplyPromo = async () => {
    if (!promoCodeInput) return;
    setPromoError("");
    setAppliedPromo(null);
    try {
      const docRef = doc(db, 'promoCodes', promoCodeInput.toUpperCase());
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const promo = docSnap.data();
        if (!promo.active) {
          setPromoError("This promo code is inactive.");
          return;
        }
        if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
          setPromoError("This promo code has expired.");
          return;
        }
        if (promo.minOrderAmount && cartTotal < promo.minOrderAmount) {
          setPromoError(`Minimum order amount of ${promo.minOrderAmount} ETB required.`);
          return;
        }
        if (promo.maxUsages && promo.usageCount >= promo.maxUsages) {
          setPromoError("This promo code has reached its usage limit.");
          return;
        }
        setAppliedPromo(promo);
        setPromoCodeInput("");
      } else {
        setPromoError("Invalid promo code.");
      }
    } catch (e) {
      setPromoError("Error verifying promo code.");
    }
  };

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) return;
    if (isMenuLoading || unavailableCartItems.length) {
      setIsCheckingOut(false);
      setCheckoutError(isMenuLoading
        ? "The menu is still loading. Please wait a moment."
        : "An item or selected option is no longer available. Remove it from your cart before checking out.");
      return;
    }
    if (!user) {
      toastWarning("Please sign in with Google to place your order.");
      handleLogin();
      setCheckoutLoading(false);
      return;
    }
    if (paymentMethod === "chapa") {
      if (isMyOrdersLoading) {
        setCheckoutLoading(false);
        toastWarning("Checking your earlier payment attempts. Please try again in a moment.");
        return;
      }
      const reconciliationOrder = myOrders.find(order => order.paymentReconciliationRequired && order.paymentStatus !== "completed" && cartMatchesOrder(cart, order.items));
      const rememberedReconciliationId = localStorage.getItem("chapaReconciliationOrderId");
      if (rememberedReconciliationId && !myOrders.some(order => order.id === rememberedReconciliationId && order.paymentReconciliationRequired && order.paymentStatus !== "completed")) {
        localStorage.removeItem("chapaReconciliationOrderId");
      }
      if (reconciliationOrder) {
        setCheckoutLoading(false);
        setIsCartOpen(false);
        setPlacedOrder(reconciliationOrder);
        setActiveOrderId(reconciliationOrder.id);
        localStorage.setItem("activeOrderId", reconciliationOrder.id);
        setIsOrderModalOpen(true);
        toastWarning("This cart has an earlier Chapa payment being reconciled. We’ll check its status before you pay again.");
        void verifyChapaPayment(reconciliationOrder.id, true);
        return;
      }
    }
    // Guard against slow network: pricing/tax/delivery fee must be loaded
    if (!settingsLoaded) {
      toastWarning("Pricing is still loading. Please wait a moment and try again.");
      return;
    }

    const emailTrimmed = customerEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed) || emailTrimmed.endsWith("@example.com")) {
      toastWarning("Please provide a valid, real email address (e.g. yourname@gmail.com) for online payment.");
      return;
    }

    setCheckoutError(null);
    setCheckoutPhoneError(null);
    setCheckoutLoading(true);

    // Make delivery address strictly required ONLY for delivery fulfillment
    if (fulfillmentType === 'delivery' && !googleMapsAddress.trim()) {
      toastWarning("Please provide a Delivery Address so our courier can locate you.");
      setCheckoutLoading(false);
      return;
    }

    // Validate scheduled time and constraints if scheduling is enabled
    let finalScheduledFor: string | null = null;
    if (scheduleEnabled && scheduledFor) {
      const totalScheduledItems = cart.reduce((sum, item) => sum + item.quantity, 0);
      if (totalScheduledItems > 2) {
        toastWarning("Scheduled orders are limited to a maximum of 2 food items to guarantee preparation time. Please reduce your cart quantity or order for immediate preparation.");
        setCheckoutLoading(false);
        return;
      }
      const prepTimeMinutes = checkoutSettings.prepTimeMinutes || 30;
      const earliest = new Date(Date.now() + prepTimeMinutes * 60 * 1000);
      if (new Date(scheduledFor).getTime() < earliest.getTime()) {
        toastWarning(`Scheduled time must be at least ${prepTimeMinutes} minutes from now. Please pick a later slot.`);
        setCheckoutLoading(false);
        return;
      }
      finalScheduledFor = new Date(scheduledFor).toISOString();
    }

    // Save the last checkout info to localStorage for autofill (Google Fill behavior)
    localStorage.setItem("lastCheckoutName", customerName.trim());
    localStorage.setItem("lastCheckoutEmail", customerEmail.trim());
    localStorage.setItem("lastCheckoutPhone", customerPhone.trim());
    localStorage.setItem("lastCheckoutBlock", blockNumber.trim());
    localStorage.setItem("lastCheckoutRoom", roomNumber.trim());
    localStorage.setItem("lastCheckoutAddress", googleMapsAddress.trim());
    localStorage.setItem("lastCheckoutUseGoogleMaps", useGoogleMaps ? "true" : "false");
    localStorage.setItem("lastCheckoutSpecialInstructions", specialInstructions.trim());

    if (subscribeNewsletter && customerEmail) {
      localStorage.setItem("newsletterAgreed", "true");
      fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: customerEmail })
      }).catch(err => console.error("Auto-subscribe failed:", err));
    }

    const nameParts = customerName.trim().split(" ");
    const firstName = nameParts[0] || "Gourmet";
    const lastName = nameParts.slice(1).join(" ") || "Diner";

    try {
      if (paymentMethod === "chapa") {
        const requestStorageKey = "chapaClientRequestId";
        let chapaRequestId = localStorage.getItem(requestStorageKey) || crypto.randomUUID().replace(/-/g, "");
        localStorage.setItem(requestStorageKey, chapaRequestId);

        const checkoutPayload = {
          email: emailTrimmed,
          first_name: firstName,
          last_name: lastName,
          phone_number: customerPhone.trim(),
          // Checkout only needs IDs, quantities, and the selected variant.
          // Sending the full menu snapshots also sends base64 images and can
          // keep the request body uploading until the browser's timeout.
          items: cart.map(({ menuItem, quantity, variationId }) => ({
            menuItemId: menuItem?.id,
            quantity,
            variationId: variationId ?? menuItem?.variation?.id ?? null
          })),
          blockNumber: fulfillmentType === "delivery" ? blockNumber : "",
          roomNumber: fulfillmentType === "delivery" ? roomNumber : "",
          googleMapsAddress: fulfillmentType === "delivery" ? googleMapsAddress : "",
          specialInstructions,
          fulfillmentType,
          scheduledFor: finalScheduledFor,
          userId: user?.uid || "",
          promoCode: appliedPromo?.code || null
        };

        const initializePayment = async (requestId: string) => {
          const controller = new AbortController();
          // Give the server's 30s checkout budget time to return a structured
          // response before the browser cancels the request itself.
          const timeoutId = window.setTimeout(() => controller.abort(), 35000);
          try {
            const response = await authedFetch("/api/chapa/initialize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({
                ...checkoutPayload,
                clientRequestId: requestId
              })
            });
            const data = await response.json().catch(() => ({}));
            return { response, data };
          } catch (error: any) {
            if (error?.name === "AbortError") return { response: { ok: false, status: 504 } as Response, data: { success: false, code: "CHAPA_TIMEOUT", error: "We’re checking your payment request. Tap Pay Online again to safely resume.", retryAction: "wait" } };
            throw error;
          } finally {
            window.clearTimeout(timeoutId);
          }
        };

        let { response: res, data } = await initializePayment(chapaRequestId);
        if (data?.retryAction === "wait" && ["CHAPA_TIMEOUT", "CHAPA_NETWORK_ERROR", "CHAPA_UNAVAILABLE", "CHAPA_INVALID_RESPONSE", "INITIALIZATION_IN_PROGRESS", "CHAPA_RECONCILING"].includes(data?.code)) {
          const txRef = data?.txRef || `PAY-${chapaRequestId}`;
          for (const delay of [2000, 5000, 10000]) {
            await new Promise(resolve => window.setTimeout(resolve, delay));
            try {
              const statusResponse = await authedFetch(`/api/chapa/attempt/${encodeURIComponent(txRef)}`);
              const attempt = await statusResponse.json().catch(() => ({}));
              if (attempt.checkoutUrl) {
                // A recovered URL is a successful initialize result even though
                // the original POST may have timed out or returned 504.
                res = { ok: true, status: 200 } as Response;
                data = { success: true, txRef, checkoutUrl: attempt.checkoutUrl, order: attempt.order };
                break;
              }
              if (attempt.retryAction === "new_reference") {
                data = { success: false, code: "PAYMENT_ATTEMPT_ENDED", retryAction: "new_reference", error: "Chapa confirmed the previous payment reference was not created." };
                break;
              }
              if (attempt.code === "PAYMENT_NOT_FOUND" && attempt.retryAction === "same_reference") {
                data = { success: false, code: "CHECKOUT_NOT_SAVED", retryAction: "same_reference", error: attempt.error || "No payment record was saved yet. Tap Pay Online again to safely resume this checkout." };
                break;
              }
              if (!statusResponse.ok && attempt.code === "AUTH_SESSION_EXPIRED") {
                data = { success: false, code: attempt.code, retryAction: "wait", error: formatCheckoutError(attempt) };
                break;
              }
              data = { ...attempt, success: false, retryAction: attempt.retryAction || "wait", error: attempt.error || "We’re checking your payment request. Tap Pay Online again to safely resume." };
            } catch (statusError: any) {
              // A failed poll does not make the payment failed. Keep the same
              // request ID so the next Pay Online click resumes this attempt.
              data = {
                success: false,
                code: statusError?.code === "AUTH_SESSION_EXPIRED" ? statusError.code : "CHAPA_RECONCILING",
                retryAction: "wait",
                error: statusError?.code === "AUTH_SESSION_EXPIRED"
                  ? formatCheckoutError(statusError)
                  : "We’re checking your payment request. Tap Pay Online again to safely resume."
              };
              break;
            }
          }
        }
        if (data?.retryAction === "new_reference" && ["PAYMENT_ATTEMPT_ENDED", "PAYMENT_REQUEST_CHANGED", "CHAPA_DUPLICATE_REFERENCE"].includes(data?.code)) {
          chapaRequestId = crypto.randomUUID().replace(/-/g, "");
          localStorage.setItem(requestStorageKey, chapaRequestId);
          ({ response: res, data } = await initializePayment(chapaRequestId));
        }

        if ((!res.ok && res.status !== 202) || !data.success) {
          if (data?.retryAction === "new_reference") localStorage.removeItem(requestStorageKey);
          throw Object.assign(new Error(formatCheckoutError(data)), { code: data?.code });
        }
        const checkoutUrl = safeChapaCheckoutUrl(data.checkoutUrl);
        if (!checkoutUrl) throw new Error("Chapa did not return a valid checkout link. Please try again.");

        localStorage.removeItem(requestStorageKey);
        localStorage.setItem("activeOrderId", data.txRef);
        setActiveOrderId(data.txRef);
        setPlacedOrder(data.order || null);
        setIsOrderModalOpen(true);

        try {
          localStorage.setItem("gourmet_cart_backup", JSON.stringify(cart));
        } catch {}

        const serverTotal = Number(data.order?.total ?? finalTotal);
        const targetUid = user?.uid || localStorage.getItem("lastAuthUid");
        pushNotification({
          uid: targetUid,
          type: "order_placed",
          title: "Order placed — complete payment",
          body: "Order #" + String(data.txRef).slice(-8).toUpperCase() + " for " + serverTotal.toFixed(2) + " ETB is awaiting payment.",
          orderId: data.txRef,
          amount: serverTotal
        }).catch(() => {});

        localStorage.setItem("chapaCheckoutUrl", checkoutUrl);
        setChapaCheckoutUrl(checkoutUrl);
        setIsCheckingOut(false);
        setIsCartOpen(false);
        setCheckoutLoading(false);
        setCheckoutError(null);
        setSpecialInstructions("");
        setBlockNumber("");
        setRoomNumber("");
        setScheduleEnabled(false);
        setScheduledFor("");
        window.location.replace(checkoutUrl);
        return;
      } else {
        // Save order as pending in DB directly for Cash
        const cashRequestStorageKey = "cashOrderClientRequestId";
        let cashRequestId = localStorage.getItem(cashRequestStorageKey) || crypto.randomUUID().replace(/-/g, "");
        localStorage.setItem(cashRequestStorageKey, cashRequestId);
        const res = await authedFetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: cart,
            total: finalTotal,
            customerName: customerName,
            customerEmail: customerEmail,
            customerPhone: customerPhone,
            blockNumber: fulfillmentType === 'delivery' ? blockNumber : "",
            roomNumber: fulfillmentType === 'delivery' ? roomNumber : "",
            googleMapsAddress: fulfillmentType === 'delivery' ? googleMapsAddress : "",
            specialInstructions,
            fulfillmentType,
            scheduledFor: finalScheduledFor,
            paymentMethod: "cash",
            paymentStatus: "pending",
            status: "pending",
            clientRequestId: cashRequestId,
            userId: user?.uid || "",
            serviceTax: taxAmount,
            flatFee: deliveryFee,
            promoCode: appliedPromo?.code,
            discountAmount
          })
        });
        let data = await res.json().catch(() => ({}));
        if (res.status === 409 && data?.code === "ORDER_REQUEST_CHANGED") {
          cashRequestId = crypto.randomUUID().replace(/-/g, "");
          localStorage.setItem(cashRequestStorageKey, cashRequestId);
          const retry = await authedFetch("/api/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: cart, customerName, customerEmail, customerPhone, blockNumber: fulfillmentType === 'delivery' ? blockNumber : "", roomNumber: fulfillmentType === 'delivery' ? roomNumber : "", googleMapsAddress: fulfillmentType === 'delivery' ? googleMapsAddress : "", specialInstructions, fulfillmentType, scheduledFor: finalScheduledFor, paymentMethod: "cash", clientRequestId: cashRequestId, promoCode: appliedPromo?.code })
          });
          data = await retry.json().catch(() => ({}));
        }

        if (data.success) {
          localStorage.removeItem(cashRequestStorageKey);
          setPlacedOrder(data.order);
          const targetUid = user?.uid || (typeof window !== "undefined" ? localStorage.getItem("lastAuthUid") : null);
          pushNotification({
            uid: targetUid,
            type: "order_placed",
            title: "Order placed!",
            body: `Order #${(data.order?.id || '').slice(-8).toUpperCase()} for ${finalTotal.toFixed(2)} ETB has been placed. Please pay cash upon arrival.`,
            orderId: data.order?.id,
            amount: finalTotal
          }).catch(() => {});
          setCart([]);
          setIsCheckingOut(false);
          setIsCartOpen(false);
          setCheckoutLoading(false);
          setSpecialInstructions("");
          setBlockNumber("");
          setRoomNumber("");
          setGoogleMapsAddress("");
          setScheduleEnabled(false);
          setScheduledFor("");
        } else {
          toastError("Failed to create cash order");
          setCheckoutLoading(false);
        }
      }
    } catch (err: any) {
      const msg = err?.name === "AbortError"
        ? "We’re checking your payment request. Tap Pay Online again to safely resume."
        : formatCheckoutError(err);
      setCheckoutError(msg);
      if (["CHECKOUT_INVALID_PHONE", "CHAPA_INVALID_PHONE"].includes(err?.code)) {
        setCheckoutPhoneError(msg);
        checkoutPhoneInput.current?.focus();
      }
      toastError(`Checkout failed: ${msg}`);
      setCheckoutLoading(false);
    }
  };

  // Filtered menu logic
  const isItemCurrentlyAvailable = (item: MenuItem): boolean => {
    if (item.menuTiming === "All Day" || (!item.menuTiming)) return true;
    if (!item.timingFrom || !item.timingTo) return true;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const parseTime = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const from = parseTime(item.timingFrom);
    const to = parseTime(item.timingTo);
    // Handle windows that cross midnight (from > to).
    if (from <= to) {
      return nowMin >= from && nowMin <= to;
    }
    return nowMin >= from || nowMin <= to;
  };

  const filteredMenu = useMemo(() => menu.filter(item => {
    const matchesCategory = selectedCategory === 'all' ||
      item.category === selectedCategory ||
      (item.categories && item.categories.includes(selectedCategory));
    const normalizedSearchQuery = searchQuery.toLowerCase();
    const matchesSearch = (item.name || '').toLowerCase().includes(normalizedSearchQuery) ||
      (item.description || '').toLowerCase().includes(normalizedSearchQuery);
    // Varied items are listed whenever at least one variation is buyable; the
    // generic isActive toggle only applies to items without variations.
    const isCurrentlyActive = itemVariations(item).length > 0
      ? itemVariations(item).some(v => isVariationAvailable(v))
      : item.isActive !== false;
    return matchesCategory && matchesSearch && isCurrentlyActive && isItemCurrentlyAvailable(item);
  }), [menu, selectedCategory, searchQuery, now]);

  // Group the filtered menu by category while preserving the categories order.
  const itemCategoryIds = useCallback((item: MenuItem) =>
    item.categories && item.categories.length > 0 ? item.categories : (item.category ? [item.category] : []), []);
    
  const categoryGroups = useMemo(() => categories
    .map(cat => ({ ...cat, items: filteredMenu.filter(item => itemCategoryIds(item).includes(cat.id)) }))
    .filter(group => group.items.length > 0), [categories, filteredMenu, itemCategoryIds]);
    
  const uncategorizedItems = useMemo(() => filteredMenu.filter(item => {
    const ids = itemCategoryIds(item);
    return ids.length === 0 || !ids.some(id => categories.some(c => c.id === id));
  }), [filteredMenu, itemCategoryIds, categories]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="animate-spin text-amber-600">
          <Utensils className="w-10 h-10" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="site-pattern min-h-screen bg-[#f7f3ec] text-stone-900 font-sans overflow-hidden">
        <header className="max-w-6xl mx-auto px-5 sm:px-8 py-5 flex items-center justify-between animate-fade-in">
          <div className="flex items-center gap-3">
            {globalSettings?.logoUrl ? (
              <img src={globalSettings.logoUrl} alt={`${businessName} logo`} decoding="async" className="h-11 w-auto max-w-40 object-contain object-left" />
            ) : null}
            <div>
              <p className="font-serif text-xl font-bold leading-none">{businessName}</p>
              <p className="text-[10px] uppercase tracking-[0.22em] text-stone-500 mt-1">Fresh food, simply ordered</p>
            </div>
          </div>
          <button
            onClick={handleLogin}
            disabled={loginLoading}
            className="hidden sm:inline-flex items-center gap-2 rounded-full bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-stone-800 transition disabled:opacity-60 cursor-pointer"
          >
            <LogIn className="h-4 w-4" />
            Sign in
          </button>
        </header>

        <main className="max-w-6xl mx-auto px-5 sm:px-8 pt-10 sm:pt-20 pb-16">
          <div className="grid lg:grid-cols-[1.08fr_0.92fr] gap-12 lg:gap-16 items-center">
            <section className="max-w-2xl">
              <h1 className="font-serif text-5xl sm:text-6xl lg:text-7xl leading-[0.96] tracking-tight animate-fade-in" style={{ animationDelay: '110ms' }}>
                Your next meal,
                <span className="block italic text-amber-700">a few taps away.</span>
              </h1>
              <p className="mt-6 text-base sm:text-lg leading-8 text-stone-600 max-w-xl animate-fade-in" style={{ animationDelay: '160ms' }}>
                Sign in to explore the menu, place your order, and follow every update from the kitchen to your door.
              </p>

              <button
                onClick={handleLogin}
                disabled={loginLoading}
                className="mt-8 w-full sm:w-auto inline-flex items-center justify-center gap-3 rounded-2xl bg-stone-900 px-7 py-4 text-sm font-bold text-white shadow-xl shadow-stone-900/15 hover:-translate-y-0.5 hover:bg-stone-800 transition disabled:opacity-60 disabled:translate-y-0 cursor-pointer animate-fade-in"
                style={{ animationDelay: '210ms' }}
              >
                {loginLoading ? (
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                ) : (
                  <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3A12 12 0 1 1 32 15.1l5.7-5.7A20 20 0 1 0 44 24c0-1.3-.1-2.6-.4-3.9Z" />
                    <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C41 35.5 44 30.6 44 24c0-1.3-.1-2.6-.4-3.9Z" />
                  </svg>
                )}
                {loginLoading ? "Connecting to Google..." : "Continue with Google"}
                {!loginLoading && <ChevronRight className="h-4 w-4" />}
              </button>

              {loginError && (
                <div className="mt-5 max-w-xl rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
                  <p className="font-semibold">Sign-in couldn’t be completed</p>
                  <p className="mt-1 text-red-600">{loginError}</p>
                </div>
              )}
            </section>

            <section className="relative animate-scale-up" style={{ animationDelay: '140ms' }}>
              <div className="absolute -inset-8 rounded-full bg-amber-300/20 blur-3xl" />
              <div className="relative rounded-[2rem] bg-stone-900 p-7 sm:p-9 text-white shadow-2xl shadow-stone-900/25 overflow-hidden">
                <div className="absolute -right-14 -top-14 h-48 w-48 rounded-full border-[34px] border-amber-400/10" />
                <h2 className="font-serif text-3xl sm:text-4xl max-w-sm">Good food without the guesswork.</h2>
                <div className="mt-9 grid gap-3">
                  {[
                    { icon: ShoppingBag, title: "Order in moments", text: "A clear menu and a quick checkout." },
                    { icon: Clock, title: "Stay updated", text: "Follow your order as it is prepared." },
                    { icon: Lock, title: "Pay with confidence", text: "Secure checkout and verified payments." }
                  ].map(({ icon: Icon, title, text }) => (
                    <div key={title} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.06] p-4 backdrop-blur transition-transform duration-200 hover:-translate-y-0.5">
                      <span className="h-11 w-11 shrink-0 grid place-items-center rounded-xl bg-amber-400 text-stone-950">
                        <Icon className="h-5 w-5" />
                      </span>
                      <div>
                        <p className="font-semibold">{title}</p>
                        <p className="text-sm text-stone-400 mt-0.5">{text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    );
  }

  return (
    <APIProvider apiKey={API_KEY} version="weekly">
      <div id="main-applet" className="site-pattern min-h-screen bg-stone-50 text-stone-900 font-sans flex flex-col antialiased selection:bg-amber-100 selection:text-amber-900">

        {/* Premium Elegant Header */}
        <header className="bg-white border-b border-stone-200 sticky top-0 z-40 backdrop-blur-md bg-white/95">
          <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
            {/* Logo / Brand */}
            <Link to="/" className="flex items-center space-x-3 cursor-pointer" aria-label="Go to homepage">
              {globalSettings?.logoUrl ? (
                <img src={globalSettings.logoUrl} alt={`${businessName} logo`} decoding="async" className="h-10 w-auto max-w-40 object-contain object-left" />
              ) : null}
              <div>
                <span className="font-serif text-xl font-bold tracking-tight text-stone-900 block leading-none">
                  {businessName}
                </span>
                {globalSettings?.restaurantName && (
                  <span className="text-[10px] font-mono tracking-widest text-stone-500 uppercase">RESTAURANT</span>
                )}
              </div>
            </Link>

            {/* Action Header Items */}
            <div className="flex items-center space-x-3 relative">
              {globalSettings?.enableReservations !== false && (
                <button
                  onClick={() => setIsReservationOpen(true)}
                  className="hidden sm:flex items-center space-x-2 p-2 px-4 bg-stone-900 hover:bg-amber-600 text-white rounded-xl transition-all cursor-pointer font-bold text-xs"
                >
                  <CalendarDays className="w-4 h-4" />
                  <span>Book Table</span>
                </button>
              )}
              {user ? (
                <div className="relative">
                  <button
                    onClick={() => setIsProfileOpen(!isProfileOpen)}
                    className="flex items-center space-x-2 p-1.5 pr-3 border border-stone-200 hover:border-stone-400 bg-stone-50 hover:bg-stone-100 rounded-full transition-all cursor-pointer text-stone-800"
                  >
                    {safeHttpsUrl(user.photoURL) ? (
                      <img src={safeHttpsUrl(user.photoURL)} alt="Profile" referrerPolicy="no-referrer" className="w-8 h-8 rounded-full border border-stone-200" />
                    ) : (
                      <span className="w-8 h-8 rounded-full border border-stone-200 bg-stone-100 flex items-center justify-center" aria-label="Profile"><User className="w-4 h-4" /></span>
                    )}
                    <span className="hidden md:block text-xs font-semibold text-stone-600">
                      {user.displayName?.split(" ")[0]}
                    </span>
                    <ChevronDown className="w-4 h-4 text-stone-400" />
                  </button>

                  {isProfileOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setIsProfileOpen(false)}
                      />
                      <div className="absolute right-0 mt-2 w-48 bg-white rounded-xl shadow-lg border border-stone-200 overflow-hidden z-50 animate-fade-in">
                        <div className="p-3 border-b border-stone-100 bg-stone-50/50">
                          <p className="text-xs font-bold text-stone-800 truncate">{user.displayName}</p>
                          <p className="text-[10px] text-stone-500 truncate">{user.email}</p>
                        </div>
                        <div className="p-1.5">
                          <button
                            onClick={() => {
                              setIsProfileOpen(false);
                              setIsMyOrdersOpen(true);
                            }}
                            className="w-full flex items-center space-x-2 px-3 py-2 text-sm text-stone-700 hover:bg-stone-100 rounded-lg transition-colors cursor-pointer"
                          >
                            <ClipboardList className="w-4 h-4 text-stone-500" />
                            <span>My Orders</span>
                          </button>
                          <button
                            onClick={() => {
                              setIsProfileOpen(false);
                              handleLogout();
                            }}
                            className="w-full flex items-center space-x-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer mt-1"
                          >
                            <LogOut className="w-4 h-4 text-red-500" />
                            <span>Log Out</span>
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleLogin}
                  className="flex items-center space-x-2 p-2 px-3 border border-stone-200 hover:border-stone-400 bg-stone-50 hover:bg-stone-100 rounded-xl transition-all cursor-pointer text-stone-800"
                  title="Sign in with Google"
                >
                  <User className="w-4.5 h-4.5" />
                  <span className="text-xs font-semibold hidden md:block">Sign In</span>
                </button>
              )}

              <NotificationCenter uid={user?.uid || null} />

              <button
                onClick={() => setIsCartOpen(true)}
                aria-label="Open cart"
                className="relative p-2.5 border border-stone-200 hover:border-stone-400 bg-stone-50 hover:bg-stone-100 rounded-xl transition-all cursor-pointer flex items-center text-stone-800"
              >
                <ShoppingCart className="w-4.5 h-4.5" />
                {cart.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-amber-600 text-white font-mono text-[9px] font-bold w-5 h-5 rounded-full flex items-center justify-center animate-scale-up">
                    {cart.reduce((sum, item) => sum + item.quantity, 0)}
                  </span>
                )}
              </button>
            </div>
          </div>
        </header>

        {/* Main Container */}
        <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">

          {!isOpen && (
            <div className="mb-8 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-2xl flex flex-col items-center justify-center text-center shadow-sm">
              <h2 className="font-serif font-bold text-lg mb-1 flex items-center space-x-2">
                <span>We're Currently {checkoutSettings.scheduleEnabled && scheduleStatus.reason === "notOpen" ? "Closed" : "Not Accepting Orders"}</span>
              </h2>
              <p className="text-xs text-rose-600 font-medium">
                {checkoutSettings.scheduleEnabled && scheduleStatus.reason === "notOpen"
                  ? `We open at ${formatTimeHHMM(checkoutSettings.openTime)}. Please check back then!`
                  : checkoutSettings.scheduleEnabled && scheduleStatus.reason === "stopOrders"
                    ? `We stop accepting orders at ${formatTimeHHMM(checkoutSettings.closeTime)} to finish preparing existing orders. See you tomorrow!`
                    : "We are not accepting orders at this time. Please check back later!"}
              </p>
            </div>
          )}

          {/* GOURMET MENU */}
          <div className="space-y-10">

            {/* Menu Filters and Search */}
            <div id="gourmet-menu-section" className="space-y-6 scroll-mt-24">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-end border-b border-stone-200 pb-5 gap-y-4">
                <div>
                  <h2 className="font-serif text-2xl font-bold text-stone-900">Our Menu</h2>
                  <p className="text-xs text-stone-500 mt-1">Select from our fresh starters, mains, and beverages.</p>
                </div>

                {/* Search and Category filters */}
                <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
                  <div className="relative flex-grow sm:max-w-xs">
                    <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400" />
                    <input
                      type="text"
                      placeholder="Search dishes..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-stone-200 bg-white rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>

                  <div className="flex flex-nowrap sm:flex-wrap gap-1.5 overflow-x-auto pb-1 sm:pb-0 max-w-full">
                    {[{ id: 'all', name: 'All Items' }, ...categories].map(cat => (
                      <button
                        key={cat.id}
                        onClick={() => setSelectedCategory(cat.id)}
                        className={`shrink-0 px-3 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all capitalize cursor-pointer ${selectedCategory === cat.id
                          ? 'bg-stone-900 text-white'
                          : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                          }`}
                      >
                        {cat.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Menu Paper Design */}
              <div className="bg-[#FAF9F6] border-2 border-transparent shadow-xl max-w-4xl mx-auto p-6 md:p-16 relative">
                <ClassicalMenuFrame />

                <div className="text-center mb-10 relative z-10">
                  <h2 className="font-serif text-2xl md:text-3xl font-bold text-stone-900 tracking-widest uppercase">The Menu</h2>
                  <div className="w-16 h-px bg-stone-400 mx-auto mt-4"></div>
                </div>

                {isMenuLoading ? (
                  <div className="py-12 space-y-6 relative z-10">
                    <div className="flex items-center justify-center space-x-2 text-amber-700 mb-6">
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-600 animate-ping" />
                      <span className="font-serif text-sm font-semibold tracking-wide uppercase">Preparing Menu...</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {[1, 2, 3, 4].map(i => (
                        <div key={i} className="animate-pulse p-4 rounded-xl bg-stone-100/60 border border-stone-200/50 space-y-3">
                          <div className="flex justify-between items-start">
                            <div className="h-4 bg-stone-200 rounded w-2/3" />
                            <div className="h-4 bg-stone-200 rounded w-16" />
                          </div>
                          <div className="h-3 bg-stone-200 rounded w-full" />
                          <div className="h-3 bg-stone-200 rounded w-4/5" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : filteredMenu.length === 0 ? (
                  <div className="text-center py-20 bg-transparent relative z-10">
                    <Utensils className="w-12 h-12 text-stone-300 mx-auto mb-3 stroke-1" />
                    <p className="text-stone-800 font-semibold text-sm">No dishes found matching your selection.</p>
                  </div>
                ) : (
                  <div className="space-y-10 relative z-10">
                    {categoryGroups.map(group => (
                      <div key={group.id}>
                        <div className="text-center mb-6">
                          <h3 className="font-serif text-xl md:text-2xl font-bold text-stone-900 tracking-widest uppercase">{group.name}</h3>
                          <div className="w-12 h-px bg-stone-300 mx-auto mt-2"></div>
                        </div>
                        <div className="space-y-6">
                          {group.items.map(dish => (
                            <div key={dish.id} className="group flex flex-col sm:flex-row justify-between items-baseline hover:bg-stone-100/50 p-3 -mx-3 rounded transition-all duration-200 hover:-translate-y-0.5">
                              <Link
                                to={`/food/${dish.id}`}
                                className="flex flex-1 min-w-0 items-start pr-4 w-full cursor-pointer"
                              >
                                <img
                                  src={dish.image}
                                  alt={dish.name}
                                  className="w-20 h-20 sm:w-24 sm:h-24 mr-3 sm:mr-4 rounded-lg object-cover bg-stone-200 border border-stone-200 flex-shrink-0"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-baseline w-full">
                                    <h3 className="font-serif font-bold text-base md:text-lg text-stone-900 group-hover:text-amber-700 truncate">{dish.name}</h3>
                                    <div className="flex-grow border-b-2 border-dotted border-stone-300 mx-3 opacity-50 relative top-[-6px]"></div>
                                  </div>
                                  <p className="text-xs md:text-sm text-stone-600 mt-1 font-serif italic line-clamp-2">{dish.description}</p>
                                  <div className="flex space-x-2 mt-2 font-sans items-center">
                                    {dish.popular && <span className="text-[10px] font-bold text-amber-700 uppercase tracking-widest">Popular</span>}

                                    {dish.menuTiming && dish.menuTiming !== "All Day" && (
                                      <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-widest">• {dish.menuTiming}{dish.timingFrom && dish.timingTo ? ` (Available ${dish.timingFrom}–${dish.timingTo})` : ''}</span>
                                    )}
                                  </div>
                                </div>
                              </Link>
                              <div className="pl-0 sm:pl-4 mt-3 sm:mt-0 shrink-0 flex flex-row sm:flex-col items-center sm:items-end justify-between w-full sm:w-auto">
                                <span className="font-mono text-base md:text-lg font-bold text-stone-900 group-hover:text-amber-700 transition-colors">{menuDisplayPrice(dish)}</span>
                                <button
                                  disabled={!isOpen}
                                  onClick={() => {
                                    if (itemVariations(dish).length > 0) {
                                      navigate(`/food/${dish.id}`);
                                    } else {
                                      addToCart(dish);
                                      toastSuccess(`Added ${dish.name} to your order`);
                                    }
                                  }}
                                  className={`mt-0 sm:mt-2 text-[10px] font-bold uppercase tracking-widest px-4 py-1.5 rounded transition-colors ${isOpen
                                    ? 'bg-stone-200 text-stone-800 hover:bg-amber-600 hover:text-white cursor-pointer'
                                    : 'bg-stone-200 text-stone-400 cursor-not-allowed'
                                    }`}
                                >
                                  {isOpen ? 'Add' : 'Closed'}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {uncategorizedItems.length > 0 && (
                      <div>
                        <div className="text-center mb-6">
                          <h3 className="font-serif text-xl md:text-2xl font-bold text-stone-900 tracking-widest uppercase">Other</h3>
                          <div className="w-12 h-px bg-stone-300 mx-auto mt-2"></div>
                        </div>
                        <div className="space-y-6">
                          {uncategorizedItems.map(dish => (
                            <div key={dish.id} className="group flex flex-col sm:flex-row justify-between items-baseline hover:bg-stone-100/50 p-3 -mx-3 rounded transition-all duration-200 hover:-translate-y-0.5">
                              <Link
                                to={`/food/${dish.id}`}
                                className="flex flex-1 min-w-0 items-start pr-4 w-full cursor-pointer"
                              >
                                <img
                                  src={dish.image}
                                  alt={dish.name}
                                  className="w-20 h-20 sm:w-24 sm:h-24 mr-3 sm:mr-4 rounded-lg object-cover bg-stone-200 border border-stone-200 flex-shrink-0"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-baseline w-full">
                                    <h3 className="font-serif font-bold text-base md:text-lg text-stone-900 group-hover:text-amber-700 truncate">{dish.name}</h3>
                                    <div className="flex-grow border-b-2 border-dotted border-stone-300 mx-3 opacity-50 relative top-[-6px]"></div>
                                  </div>
                                  <p className="text-xs md:text-sm text-stone-600 mt-1 font-serif italic line-clamp-2">{dish.description}</p>
                                  <div className="flex space-x-2 mt-2 font-sans items-center">
                                    {dish.popular && <span className="text-[10px] font-bold text-amber-700 uppercase tracking-widest">Popular</span>}

                                    {dish.menuTiming && dish.menuTiming !== "All Day" && (
                                      <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-widest">• {dish.menuTiming}{dish.timingFrom && dish.timingTo ? ` (Available ${dish.timingFrom}–${dish.timingTo})` : ''}</span>
                                    )}
                                  </div>
                                </div>
                              </Link>
                              <div className="pl-0 sm:pl-4 mt-3 sm:mt-0 shrink-0 flex flex-row sm:flex-col items-center sm:items-end justify-between w-full sm:w-auto">
                                <span className="font-mono text-base md:text-lg font-bold text-stone-900 group-hover:text-amber-700 transition-colors">{menuDisplayPrice(dish)}</span>
                                <button
                                  disabled={!isOpen}
                                  onClick={() => {
                                    if (itemVariations(dish).length > 0) {
                                      navigate(`/food/${dish.id}`);
                                    } else {
                                      addToCart(dish);
                                      toastSuccess(`Added ${dish.name} to your order`);
                                    }
                                  }}
                                  className={`mt-0 sm:mt-2 text-[10px] font-bold uppercase tracking-widest px-4 py-1.5 rounded transition-colors ${isOpen
                                    ? 'bg-stone-200 text-stone-800 hover:bg-amber-600 hover:text-white cursor-pointer'
                                    : 'bg-stone-200 text-stone-400 cursor-not-allowed'
                                    }`}
                                >
                                  {isOpen ? 'Add' : 'Closed'}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Cart lateral Drawer Overlay */}
        {isCartOpen && (
          <div
            id="cart-drawer-overlay"
            className="fixed inset-0 bg-black/45 z-50 flex justify-end backdrop-blur-xs"
            onClick={() => { setIsCartOpen(false); setIsCheckingOut(false); }}
          >
            <div
              className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col justify-between animate-slide-left font-sans"
              onClick={(e) => { e.stopPropagation(); }}
            >
              {/* Header */}
              <div className="p-6 border-b border-stone-100 flex items-center justify-between bg-stone-50">
                <div className="flex items-center space-x-2.5">
                  <ShoppingCart className="w-5 h-5 text-stone-800" />
                  <h3 className="font-serif text-lg font-bold text-stone-900">Your Gourmet Order</h3>
                </div>
                <button
                  onClick={() => { setIsCartOpen(false); setIsCheckingOut(false); }}
                  className="p-1 text-stone-400 hover:text-stone-800 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Cart Items */}
              <div className="flex-grow overflow-y-auto p-6 space-y-4">
                {cart.length === 0 ? (
                  <div className="text-center py-20 text-stone-400">
                    <ShoppingCart className="w-12 h-12 mx-auto mb-3 stroke-1 text-stone-300" />
                    <p className="text-sm font-medium">Your gourmet cart is currently empty.</p>
                    <button
                      onClick={() => setIsCartOpen(false)}
                      className="text-amber-600 font-bold text-xs mt-2 underline cursor-pointer"
                    >
                      Add some dishes
                    </button>
                  </div>
                ) : (
                  !isCheckingOut ? (
                    cart.map((item) => (
                      <div key={`${item.menuItem.id}-${item.variationId || ''}`} className="flex justify-between items-center pb-4 border-b border-stone-100 animate-fade-in">
                        <div className="flex items-center space-x-3 truncate">
                          <img src={item.menuItem.image} alt={item.menuItem.name} className="w-12 h-12 rounded-lg object-cover bg-stone-100 border border-stone-200 flex-shrink-0" />
                          <div className="truncate">
                            <h4 className="font-serif font-bold text-stone-950 text-sm leading-tight">{item.menuItem.name}</h4>
                            {unavailableCartItems.includes(item) && (
                              <p className="mt-1 text-[10px] font-semibold text-rose-700">No longer available — remove this item</p>
                            )}
                            {item.menuItem.variation?.label && (
                              <span className="text-[10px] text-amber-700 font-semibold block mt-0.5">{item.menuItem.variation.label}</span>
                            )}
                            <span className="text-xs text-amber-700 font-semibold font-mono block mt-1">{item.menuItem.price.toFixed(2)} ETB</span>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2.5">
                          <div className="flex items-center border border-stone-200 rounded-lg bg-stone-50">
                            <button aria-label={`Decrease ${item.menuItem.name} quantity`} onClick={() => updateCartQuantity(item.menuItem.id, item.variationId, -1)} className="grid h-9 w-9 place-items-center text-stone-500 hover:text-stone-900 cursor-pointer">
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <span className="px-2 text-xs font-bold font-mono text-stone-800">{item.quantity}</span>
                            <button aria-label={`Increase ${item.menuItem.name} quantity`} onClick={() => updateCartQuantity(item.menuItem.id, item.variationId, 1)} className="grid h-9 w-9 place-items-center text-stone-500 hover:text-stone-900 cursor-pointer">
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <button onClick={() => removeFromCart(item.menuItem.id, item.variationId)} className="text-stone-400 hover:text-rose-600 p-1 cursor-pointer">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    /* Checkout Form */
                    <form onSubmit={handleCheckout} className="space-y-4 animate-fade-in">
                      <div className="pb-2 border-b border-stone-200">
                        <h4 className="font-serif font-bold text-sm text-stone-900">Delivery & Checkout Information</h4>
                        <p className="text-[11px] text-stone-500 mt-0.5">Please provide your details below to finalize your secure transaction.</p>
                      </div>

                      <div className="space-y-3">
                        <div>
                          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">How would you like to receive your order?</label>
                          <div className="grid grid-cols-3 gap-2">
                            {([
                              { id: 'delivery', label: 'Delivery', icon: <Truck className="w-5 h-5" /> },
                              { id: 'pickup', label: "I'll take it myself", icon: <ShoppingBag className="w-5 h-5" /> },
                              { id: 'dineIn', label: 'I can eat there', icon: <Store className="w-5 h-5" /> }
                            ] as { id: 'delivery' | 'pickup' | 'dineIn'; label: string; icon: React.ReactNode }[]).map(opt => (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setFulfillmentType(opt.id)}
                                className={`p-2.5 rounded-xl border flex flex-col items-center justify-center space-y-1 text-center transition-all cursor-pointer ${fulfillmentType === opt.id
                                  ? 'border-amber-500 bg-amber-50 text-amber-900 ring-1 ring-amber-500/30'
                                  : 'border-stone-300 text-stone-500 hover:border-stone-400 bg-white'
                                  }`}
                              >
                                {opt.icon}
                                <span className="text-[10px] font-bold leading-tight">{opt.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {fulfillmentType === 'delivery' && (
                          <div className="bg-amber-50 border border-amber-200/60 rounded-xl p-3 text-[11px] text-amber-800 leading-relaxed space-y-0.5">
                            <span className="font-bold block text-[12px] text-amber-900"> Exact Address Required </span>
                            Please provide your <strong className="text-amber-950">Delivery Address</strong>. Block and Room numbers are secondary.
                          </div>
                        )}
                        {fulfillmentType !== 'delivery' && (
                          <div className="bg-emerald-50 border border-emerald-200/60 rounded-xl p-3 text-[11px] text-emerald-800 leading-relaxed">
                            {fulfillmentType === 'dineIn'
                              ? "You'll be served at the restaurant. No delivery fee applies and your order will be ready for you on site."
                              : "You'll pick this up yourself. No delivery fee applies and your order will be ready for pickup."}
                          </div>
                        )}

                        {fulfillmentType === 'delivery' && (
                          <>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Block Number</label>
                                <input
                                  type="text"
                                  name="address-line2"
                                  autoComplete="address-line2"
                                  value={blockNumber}
                                  onChange={e => setBlockNumber(e.target.value)}
                                  placeholder="e.g., Block 4"
                                  className="w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Room Number</label>
                                <input
                                  type="text"
                                  name="room"
                                  value={roomNumber}
                                  onChange={e => setRoomNumber(e.target.value)}
                                  placeholder="e.g., Room 12B"
                                  className="w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                                />
                              </div>
                            </div>

                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide">Delivery Address *</label>
                                <button
                                  type="button"
                                  onClick={() => setUseGoogleMaps(!useGoogleMaps)}
                                  className="text-[10px] text-amber-600 hover:text-amber-800 underline font-semibold cursor-pointer"
                                >
                                  {useGoogleMaps ? "Use text input instead" : "Use Google Maps"}
                                </button>
                              </div>
                              {useGoogleMaps ? (
                                <GoogleMapsAddressInput
                                  value={googleMapsAddress}
                                  onChange={setGoogleMapsAddress}
                                />
                              ) : (
                                <input
                                  type="text"
                                  name="street-address"
                                  autoComplete="street-address"
                                  value={googleMapsAddress}
                                  onChange={e => setGoogleMapsAddress(e.target.value)}
                                  placeholder="e.g., Bole, near Edna Mall"
                                  className="w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                                />
                              )}
                            </div>
                          </>
                        )}

                        {/* Schedule for later */}
                        <fieldset className="border border-stone-200 rounded-2xl bg-stone-50/60 p-3">
                          <legend className="sr-only">Order timing</legend>
                          <p aria-hidden="true" className="mb-2.5 text-[10px] font-bold text-stone-500 uppercase tracking-wide">Order timing</p>
                          <div className="grid grid-cols-2 gap-2">
                            {[
                              { later: false, label: "As soon as possible", description: "Start preparing now", icon: Clock },
                              { later: true, label: "Schedule for later", description: "Choose a time", icon: CalendarDays }
                            ].map(({ later, label, description, icon: Icon }) => {
                              const selected = scheduleEnabled === later;
                              return (
                                <label key={label} className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-3 cursor-pointer transition-colors duration-150 focus-within:ring-2 focus-within:ring-amber-400 focus-within:ring-offset-2 ${selected ? "border-stone-900 bg-stone-900 text-white shadow-sm" : "border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50"}`}>
                                  <input type="radio" name="checkout-timing" value={later ? "later" : "asap"} checked={selected} onChange={() => {
                                    setScheduleEnabled(later);
                                    if (!later) setScheduledFor("");
                                  }} className="sr-only" />
                                  <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${selected ? "text-amber-300" : "text-stone-400"}`} />
                                  <span className="min-w-0">
                                    <span className="block text-[11px] font-semibold leading-tight">{label}</span>
                                    <span className={`mt-1 block text-[10px] leading-tight ${selected ? "text-stone-300" : "text-stone-500"}`}>{description}</span>
                                  </span>
                                </label>
                              );
                            })}
                          </div>

                          {scheduleEnabled && (
                            <div className="mt-3 border-t border-stone-200 pt-3 animate-fade-in">
                              <label htmlFor="checkout-scheduled-time" className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1.5">Pick a time slot</label>
                              <div className="relative">
                              <select
                                id="checkout-scheduled-time"
                                required
                                aria-describedby="checkout-scheduling-help"
                                value={scheduledFor}
                                onChange={e => setScheduledFor(e.target.value)}
                                className="w-full appearance-none text-xs border border-stone-200 rounded-xl pl-3 pr-9 py-3 focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-500/20 bg-white shadow-sm"
                              >
                                <option value="">Select a time...</option>
                                {(() => {
                                  const prepTimeMinutes = checkoutSettings.prepTimeMinutes || 30;
                                  const stepMinutes = checkoutSettings.scheduledStepsMinutes || 15;
                                  const slots: { value: string; label: string }[] = [];
                                  const start = new Date(Date.now() + prepTimeMinutes * 60 * 1000);
                                  start.setSeconds(0, 0);
                                  const roundedMin = Math.ceil(start.getMinutes() / stepMinutes) * stepMinutes;
                                  start.setMinutes(roundedMin, 0, 0);
                                  for (let i = 0; i < 12; i++) {
                                    const slot = new Date(start.getTime() + i * stepMinutes * 60 * 1000);
                                    slots.push({
                                      value: slot.toISOString(),
                                      label: `${slot.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${slot.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                                    });
                                  }
                                  return slots.map(s => (
                                    <option key={s.value} value={s.value}>{s.label}</option>
                                  ));
                                })()}
                              </select>
                              <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                              </div>
                              <p id="checkout-scheduling-help" className="text-[10px] leading-relaxed text-stone-500 mt-2">Allow at least {checkoutSettings.prepTimeMinutes || 30} minutes for preparation.</p>
                              {cart.reduce((sum, item) => sum + item.quantity, 0) > 2 && (
                                <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-2 text-[10px] text-amber-800 flex items-start gap-1.5">
                                  <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                                  <span>Scheduled orders are limited to a maximum of 2 food items. Please reduce your cart items to proceed with scheduling.</span>
                                </div>
                              )}
                            </div>
                          )}
                        </fieldset>
                        <div>
                          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Customer Full Name *</label>
                          <input
                            type="text"
                            name="name"
                            autoComplete="name"
                            required
                            value={customerName}
                            onChange={e => setCustomerName(e.target.value)}
                            placeholder="e.g., Alula Yohannes"
                            className="w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Email Address *</label>
                          <input
                            type="email"
                            name="email"
                            autoComplete="email"
                            required
                            value={customerEmail}
                            onChange={e => setCustomerEmail(e.target.value)}
                            placeholder="yourname@gmail.com"
                            className="w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Mobile Contact Phone *</label>
                          <input
                            type="tel"
                            ref={checkoutPhoneInput}
                            name="tel"
                            autoComplete="tel"
                            aria-invalid={!!checkoutPhoneError}
                            aria-describedby="checkout-phone-help"
                            required
                            value={customerPhone}
                            onChange={e => {
                              setCustomerPhone(e.target.value);
                              if (checkoutPhoneError) {
                                setCheckoutPhoneError(null);
                                setCheckoutError(null);
                              }
                            }}
                            placeholder="09xxxxxxxx or 07xxxxxxxx"
                            className="w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                          />
                          <p id="checkout-phone-help" className={`mt-1 text-[10px] ${checkoutPhoneError ? "text-rose-700" : "text-stone-500"}`}>
                            {checkoutPhoneError || "Enter an Ethiopian mobile number starting with 09 or 07, or use +251 followed by 9 or 7 and eight digits."}
                          </p>
                        </div>

                        <div>
                          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Extra Information</label>
                          <textarea
                            value={specialInstructions}
                            onChange={e => setSpecialInstructions(e.target.value)}
                            placeholder="Allergies, door code, extra napkins..."
                            rows={2}
                            className="w-full text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                          />
                        </div>

                        {globalSettings?.enableMarketing !== false && localStorage.getItem("newsletterAgreed") !== "true" && (
                          <div className="flex items-start space-x-2 pt-1 pb-1">
                            <input
                              type="checkbox"
                              id="subscribeNewsletter"
                              checked={subscribeNewsletter}
                              onChange={(e) => setSubscribeNewsletter(e.target.checked)}
                              className="mt-0.5 rounded border-stone-300 text-amber-600 focus:ring-amber-500"
                            />
                            <label htmlFor="subscribeNewsletter" className="text-xs text-stone-600 leading-tight">
                              Keep me updated on new menus, special offers, and events via email.
                            </label>
                          </div>
                        )}

                        {/* Payment Method Selector */}
                        <div className="pt-2">
                          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-2">Secure Payment Gateway</label>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => setPaymentMethod('chapa')}
                              className={`p-3 rounded-xl border flex flex-col items-center justify-center space-y-1 transition-all cursor-pointer ${paymentMethod === 'chapa'
                                ? 'border-[#14233c] bg-[#071224] text-white font-bold shadow-sm'
                                : 'border-stone-200 text-stone-500 hover:bg-stone-50'
                                }`}
                            >
                              <div className="flex items-center space-x-1.5">
                                <div className="bg-white p-0.5 rounded-md flex items-center justify-center shadow-2xs">
                                  <ChapaLogoSVG className="w-5 h-5 flex-shrink-0" />
                                </div>
                                <span className="text-[10px]">Online Pay</span>
                              </div>
                              <span className="text-[8px] opacity-75">Telebirr / Cards</span>
                            </button>
                            <button
                              type="button"
                              disabled={!checkoutSettings.enableCOD}
                              onClick={() => setPaymentMethod('cash')}
                              className={`p-3 rounded-xl border flex flex-col items-center justify-center space-y-1 transition-all cursor-pointer ${paymentMethod === 'cash'
                                ? 'border-amber-600 bg-amber-50 text-amber-950 font-bold'
                                : checkoutSettings.enableCOD
                                  ? 'border-stone-200 text-stone-500 hover:bg-stone-50'
                                  : 'border-stone-200 bg-stone-100 text-stone-300 cursor-not-allowed opacity-60'
                                }`}
                            >
                              <Banknote className={`w-4 h-4 ${checkoutSettings.enableCOD ? 'text-stone-700' : 'text-stone-300'}`} />
                              <span className="text-[10px]">Cash on Delivery</span>
                              {!checkoutSettings.enableCOD && <span className="text-[7px] uppercase font-bold text-rose-500"></span>}
                            </button>
                          </div>
                        </div>
                      </div>

                      <button type="submit" className="hidden" id="hidden-submit-trigger" />
                    </form>
                  )
                )}
              </div>

              {/* Footer Summary & Main Action */}
              {cart.length > 0 && (
                <div className="p-6 border-t border-stone-200 bg-stone-50">

                  {isCheckingOut && (
                    <div className="mb-4 space-y-3 pb-4 border-b border-stone-200">
                      <div>
                        <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Promo Code</label>
                        <div className="flex space-x-2">
                          <input
                            type="text"
                            value={promoCodeInput}
                            onChange={(e) => setPromoCodeInput(e.target.value)}
                            placeholder="Enter code"
                            disabled={!!appliedPromo}
                            className="flex-1 text-xs border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-white"
                          />
                          {appliedPromo ? (
                            <button
                              type="button"
                              onClick={() => setAppliedPromo(null)}
                              className="bg-stone-200 text-stone-700 px-3 py-2 rounded-lg text-xs font-bold"
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={handleApplyPromo}
                              className="bg-stone-900 text-white px-3 py-2 rounded-lg text-xs font-bold"
                            >
                              Apply
                            </button>
                          )}
                        </div>
                        {promoError && <p className="text-rose-500 text-[10px] mt-1">{promoError}</p>}
                      </div>

                    </div>
                  )}

                  <div className="space-y-1.5 mb-4 text-xs text-stone-600">
                    <div className="flex justify-between">
                      <span>Subtotal</span>
                      <span className="font-mono">{cartTotal.toFixed(2)} ETB</span>
                    </div>
                    {!settingsLoaded ? (
                      <div className="flex justify-between text-stone-400">
                        <span>Service Tax & Delivery Fee</span>
                        <span className="font-mono animate-pulse">Loading...</span>
                      </div>
                    ) : (
                      <>
                        {checkoutSettings.serviceTaxPercent > 0 && (
                          <div className="flex justify-between">
                            <span>Service Tax ({checkoutSettings.serviceTaxPercent}%)</span>
                            <span className="font-mono">+{taxAmount.toFixed(2)} ETB</span>
                          </div>
                        )}
                        <div className="flex justify-between">
                          <span>{fulfillmentType === 'delivery' ? 'Delivery Fee' : 'Fulfillment'}</span>
                          {fulfillmentType === 'delivery' ? (
                            deliveryFee > 0 ? (
                              <span className="font-mono">+{deliveryFee.toFixed(2)} ETB</span>
                            ) : (
                              <span className="text-emerald-700 font-bold">FREE</span>
                            )
                          ) : (
                            <span className="text-emerald-700 font-bold">No delivery fee</span>
                          )}
                        </div>
                      </>
                    )}
                    {appliedPromo && (
                      <div className="flex justify-between text-emerald-700 font-semibold">
                        <span>Promo ({appliedPromo.code})</span>
                        <span className="font-mono">-{discountAmount.toFixed(2)} ETB</span>
                      </div>
                    )}
                    <div className="flex justify-between text-stone-900 font-bold text-sm pt-2 border-t border-stone-200">
                      <span>Total Bill:</span>
                      {!settingsLoaded ? (
                        <span className="font-mono text-stone-400 animate-pulse">Loading...</span>
                      ) : (
                        <span className="font-mono text-amber-700">{finalTotal.toFixed(2)} ETB</span>
                      )}
                    </div>
                  </div>

                  {!user && (
                    <div className="mb-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-center justify-between text-xs animate-fade-in">
                      <div className="pr-2">
                        <p className="font-bold text-stone-900">Sign in to complete order</p>
                        <p className="text-[11px] text-stone-500">Sign in with Google to pay & track delivery</p>
                      </div>
                      <button
                        type="button"
                        onClick={handleLogin}
                        disabled={loginLoading}
                        className="bg-stone-900 hover:bg-stone-800 text-white font-bold px-3.5 py-2 rounded-xl text-xs transition cursor-pointer flex items-center space-x-1.5 shadow-sm shrink-0"
                      >
                        <LogIn className="w-3.5 h-3.5" />
                        <span>Sign In</span>
                      </button>
                    </div>
                  )}

                  {checkoutError && (
                    <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3 text-left text-xs text-rose-800 animate-fade-in" role="alert">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="font-bold">Checkout needs your attention</p>
                        <p className="mt-0.5 leading-relaxed text-rose-700">{checkoutError}</p>
                      </div>
                    </div>
                  )}

                  {unavailableCartItems.length > 0 && (
                    <div role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                      <p>Some saved items or options are no longer on the menu. Remove them before checkout.</p>
                      <button type="button" onClick={() => {
                        setCart(previous => previous.filter(item => !unavailableCartItems.some(unavailable =>
                          unavailable.menuItem.id === item.menuItem.id &&
                          (unavailable.variationId ?? unavailable.menuItem.variation?.id ?? "") ===
                          (item.variationId ?? item.menuItem.variation?.id ?? ""))));
                        setCheckoutError(null);
                        setIsCheckingOut(false);
                      }} className="mt-2 font-bold underline cursor-pointer">Remove unavailable items</button>
                    </div>
                  )}
                  {!isCheckingOut ? (
                    <button
                      disabled={!isOpen || !settingsLoaded || isMenuLoading || unavailableCartItems.length > 0}
                      onClick={() => {
                        if (!user) {
                          toastWarning("Please sign in with Google to proceed with your order.");
                          handleLogin();
                          return;
                        }
                        setCheckoutError(null);
                        setIsCheckingOut(true);
                        if (!customerName) setCustomerName(localStorage.getItem("lastCheckoutName") || "");
                        if (!customerEmail) setCustomerEmail(localStorage.getItem("lastCheckoutEmail") || "");
                        if (!customerPhone) setCustomerPhone(localStorage.getItem("lastCheckoutPhone") || "");
                        if (!blockNumber) setBlockNumber(localStorage.getItem("lastCheckoutBlock") || "");
                        if (!roomNumber) setRoomNumber(localStorage.getItem("lastCheckoutRoom") || "");
                        if (!googleMapsAddress) setGoogleMapsAddress(localStorage.getItem("lastCheckoutAddress") || "");
                        const savedUseGoogleMaps = localStorage.getItem("lastCheckoutUseGoogleMaps");
                        if (savedUseGoogleMaps !== null) {
                          setUseGoogleMaps(savedUseGoogleMaps === "true");
                        }
                      }}
                      className={`w-full font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-all flex items-center justify-center ${isOpen && settingsLoaded && !isMenuLoading && !unavailableCartItems.length ? 'bg-stone-900 hover:bg-amber-600 text-white cursor-pointer' : 'bg-stone-300 text-stone-500 cursor-not-allowed'
                        }`}
                    >
                      <span>{!settingsLoaded ? 'Loading pricing...' : !user ? 'Sign In with Google to Order' : isOpen ? (fulfillmentType === 'delivery' ? 'Proceed to Delivery details' : 'Proceed to Checkout') : 'Currently Closed'}</span>
                      {isOpen && settingsLoaded && <ChevronRight className="w-4 h-4 ml-1" />}
                    </button>
                  ) : (
                    <div className="flex space-x-2">
                      <button
                        onClick={() => {
                          const trigger = document.getElementById("hidden-submit-trigger");
                          trigger?.click();
                        }}
                        disabled={checkoutLoading || !settingsLoaded}
                        className={`flex-1 font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-all flex items-center justify-center cursor-pointer disabled:opacity-50 ${paymentMethod === 'chapa'
                          ? 'bg-[#071224] hover:bg-[#0c1e3a] text-white space-x-1.5'
                          : 'bg-amber-600 hover:bg-amber-700 text-white'
                          }`}
                      >
                        {checkoutLoading ? (
                          <span className="flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {paymentMethod === 'chapa' ? 'Starting secure checkout…' : 'Placing order…'}
                          </span>
                        ) : (
                          paymentMethod === 'chapa' ? (
                            <span className="flex items-center space-x-2 justify-center">
                              <div className="bg-white p-0.5 rounded-md flex items-center justify-center shadow-2xs">
                                <ChapaLogoSVG className="w-4.5 h-4.5 flex-shrink-0" />
                              </div>
                              <span>Pay Online</span>
                            </span>
                          ) : 'Confirm Order'
                        )}
                      </button>
                      <button
                        onClick={() => {
                          setCheckoutError(null);
                          setIsCheckingOut(false);
                        }}
                        className="bg-stone-200 hover:bg-stone-300 text-stone-700 font-bold px-4 py-3 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer"
                      >
                        Back
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}



        {/* Chapa Transaction Receipt Modal Overlay */}
        {selectedReceiptOrder && (
          <div id="receipt-modal" className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in" onClick={() => setSelectedReceiptOrder(null)}>
            <div className="bg-amber-50/5 text-stone-900 rounded-2xl max-w-md w-full relative flex flex-col shadow-2xl border border-stone-200 overflow-hidden animate-scale-up max-h-[90vh]" onClick={e => e.stopPropagation()}>
              {/* Paper receipt design */}
              <div className="bg-[#FAF9F6] p-6 flex-grow overflow-y-auto font-mono text-xs text-stone-800 space-y-6 select-none relative">
                {/* Paper perforation top style */}
                <div className="absolute top-0 left-0 right-0 h-1.5 bg-[linear-gradient(45deg,transparent_33.333%,#FAF9F6_33.333%,#FAF9F6_66.667%,transparent_66.667%),linear-gradient(-45deg,transparent_33.333%,#FAF9F6_33.333%,#FAF9F6_66.667%,transparent_66.667%)] bg-[size:10px_10px] -mt-1"></div>

                {/* Receipt Header */}
                <div className="text-center space-y-2 mt-2">
                  <h2 className="text-lg font-serif font-black tracking-tight text-stone-950 uppercase">{businessName}</h2>
                  <div className="border-b border-dashed border-stone-300 my-4" />
                  <h3 className="text-[11px] font-bold text-stone-950 tracking-wider">TRANSACTION RECEIPT</h3>
                  <p className="text-[10px] text-stone-400">STATUS:PAID</p>
                </div>

                {/* Transaction Metadata */}
                <div className="space-y-1 bg-stone-100/60 p-3 rounded-lg border border-stone-200/50 font-sans">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-stone-500">Date:</span>
                    <span className="font-mono text-stone-900">{new Date(selectedReceiptOrder.receipt?.date || selectedReceiptOrder.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-stone-500">Tx Ref:</span>
                    <span className="font-mono text-stone-900">{selectedReceiptOrder.id}</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-stone-500">Transaction ID:</span>
                    <span className="font-mono text-stone-900 text-right max-w-[180px] truncate">{selectedReceiptOrder.receipt?.transactionId || `chapa-sim-${selectedReceiptOrder.id}`}</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-stone-500">Method:</span>
                    <span className="font-semibold text-emerald-800 font-sans uppercase">{selectedReceiptOrder.receipt?.paymentMethod || "Online (CBE/Telebirr)"}</span>
                  </div>
                  {selectedReceiptOrder.paymentMethod === "chapa" && (
                    <div className="flex justify-between items-center text-[11px] pt-1.5 mt-1.5 border-t border-stone-200/40">
                      <span className="text-stone-500 font-medium">Receipt:</span>
                      <a
                        href={`https://chapa.link/payment-receipt/${selectedReceiptOrder.receipt?.reference || selectedReceiptOrder.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-bold text-emerald-700 hover:text-emerald-800 underline flex items-center gap-0.5 cursor-pointer"
                      >
                        View Receipt <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                </div>

                {/* Customer Info */}
                <div className="space-y-1 text-[11px] font-sans border-t border-b border-dashed border-stone-300 py-3">
                  <div className="flex justify-between">
                    <span className="text-stone-500">Customer:</span>
                    <span className="font-bold text-stone-900">{selectedReceiptOrder.customerName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stone-500">Email:</span>
                    <span className="text-stone-900">{selectedReceiptOrder.customerEmail}</span>
                  </div>
                  {selectedReceiptOrder.customerPhone && (
                    <div className="flex justify-between">
                      <span className="text-stone-500">Phone:</span>
                      <span className="text-stone-900">{selectedReceiptOrder.customerPhone}</span>
                    </div>
                  )}
                  {(selectedReceiptOrder.blockNumber || selectedReceiptOrder.roomNumber) && (
                    <div className="flex justify-between">
                      <span className="text-stone-500">Deliver to:</span>
                      <span className="text-stone-900">Block {selectedReceiptOrder.blockNumber || "N/A"}, Room {selectedReceiptOrder.roomNumber || "N/A"}</span>
                    </div>
                  )}
                </div>

                {/* Items Table */}
                <div className="space-y-2">
                  <span className="text-[10px] font-bold text-stone-500 tracking-wider uppercase block">Order Details</span>
                  <div className="space-y-1.5">
                    {selectedReceiptOrder.items.map((item, idx) => (
                      <div key={idx} className="flex justify-between text-[11px]">
                        <span className="text-stone-800">
                          {item.quantity}x {item.menuItem?.id ? (
                            <Link to={`/food/${item.menuItem.id}`} onClick={() => setSelectedReceiptOrder(null)} className="hover:text-amber-700 hover:underline">{item.menuItem.name}</Link>
                          ) : (
                            item.menuItem?.name || "Gourmet Dish"
                          )}
                          {item.menuItem?.variation?.label && (
                            <span className="text-stone-400"> ({item.menuItem.variation.label})</span>
                          )}
                        </span>
                        <span className="font-mono text-stone-950 font-medium">{((item.menuItem?.price || 0) * item.quantity).toFixed(2)} ETB</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Fee Breakdown */}
                <div className="border-t border-stone-200 pt-3 space-y-1.5 text-[11px] font-sans">
                  {selectedReceiptOrder.serviceTax ? (
                    <div className="flex justify-between text-stone-500">
                      <span>Service Tax:</span>
                      <span className="font-mono">{selectedReceiptOrder.serviceTax.toFixed(2)} ETB</span>
                    </div>
                  ) : null}
                  {selectedReceiptOrder.flatFee ? (
                    <div className="flex justify-between text-stone-500">
                      <span>Flat Delivery Fee:</span>
                      <span className="font-mono">{selectedReceiptOrder.flatFee.toFixed(2)} ETB</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between font-bold text-stone-950 text-xs border-t border-stone-200/60 pt-2 font-mono">
                    <span>TOTAL PAID:</span>
                    <span className="text-emerald-700">{selectedReceiptOrder.total.toFixed(2)} ETB</span>
                  </div>
                </div>

                {/* QR Code and thank you */}
                <div className="text-center space-y-4 pt-4 border-t border-dashed border-stone-300">
                  <div className="flex flex-col items-center justify-center space-y-1.5">
                    {/* Real QR Code */}
                    <div className="bg-white p-2 rounded-lg border border-stone-200 inline-block shadow-xs">
                      <ReceiptQrCode
                        value={JSON.stringify({
                            orderId: selectedReceiptOrder.id,
                            name: selectedReceiptOrder.customerName,
                            total: `${selectedReceiptOrder.total.toFixed(2)} ETB`,
                            date: selectedReceiptOrder.receipt?.date || selectedReceiptOrder.createdAt,
                            payment: selectedReceiptOrder.receipt?.paymentMethod || "Online"
                          })}
                      />
                    </div>
                    <span className="text-[9px] font-mono text-stone-400 tracking-widest uppercase">Order details: {selectedReceiptOrder.id}</span>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[11px] font-serif font-bold italic text-stone-950">Thank you for ordering!</p>
                    <p className="text-[10px] text-stone-400">Enjoy your gourmet meal.</p>
                    {(globalSettings?.businessEmail || globalSettings?.businessPhone || globalSettings?.businessAddress) && (
                      <div className="pt-3 mt-2 border-t border-dashed border-stone-200 space-y-0.5 text-[9px] text-stone-500 font-sans">
                        <p className="font-bold text-stone-700 uppercase tracking-widest text-[8px]">{businessName}</p>
                        {globalSettings?.businessAddress && <p>{globalSettings.businessAddress}</p>}
                        {globalSettings?.businessPhone && <p>Tel: {globalSettings.businessPhone}</p>}
                        {globalSettings?.businessEmail && <p className="break-all">{globalSettings.businessEmail}</p>}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Modal Controls */}
              <div className="bg-stone-100 px-6 py-4 flex space-x-3 border-t border-stone-200">
                <button
                  onClick={() => window.print()}
                  className="flex-1 bg-stone-200 hover:bg-stone-300 text-stone-800 font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
                >
                  <span>Print / Save PDF 🖨️</span>
                </button>
                <button
                  onClick={() => setSelectedReceiptOrder(null)}
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                >
                  Close Receipt
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Unified Order & Payment Status Modal */}
        {isOrderModalOpen && (activeOrderId || placedOrder) && (
          <div id="order-status-modal" className="fixed inset-0 bg-black/70 z-[999] flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in" onClick={() => {
            if (paymentVerificationResult === 'success' || paymentVerificationResult === 'failed' || placedOrder?.paymentStatus === 'completed' || placedOrder?.paymentStatus === 'failed') {
              setIsOrderModalOpen(false);
              setActiveOrderId(null);
              setPlacedOrder(null);
              setPaymentVerificationResult(null);
              localStorage.removeItem('activeOrderId');
              localStorage.removeItem('shownOrderModalId');
            }
          }}>
            <div className="bg-white rounded-3xl max-w-md w-full p-6 sm:p-8 text-center shadow-2xl border border-stone-100 animate-scale-up space-y-5 font-sans relative" onClick={e => e.stopPropagation()}>
              {/* Close Button */}
              <button
                onClick={() => {
                  setIsOrderModalOpen(false);
                  setActiveOrderId(null);
                  setPlacedOrder(null);
                  setPaymentVerificationResult(null);
                  localStorage.removeItem('activeOrderId');
                  localStorage.removeItem('shownOrderModalId');
                }}
                className="absolute top-4 right-4 p-1.5 rounded-full text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition cursor-pointer"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>

              {/* State 1: Verifying / Syncing initial details */}
              {(isVerifying || (!placedOrder && paymentVerificationResult !== 'failed' && paymentVerificationResult !== 'success') || paymentVerificationResult === 'verifying') && (
                <>
                  <div className="w-16 h-16 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-1">
                    <Loader2 className="h-7 w-7 animate-spin text-amber-600" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-serif text-xl font-bold text-stone-950">Confirming Order Status</h3>
                    <p className="text-xs text-stone-500">Please wait while we sync your order and verify payment...</p>
                  </div>

                  {/* Immediate skeleton details card - zero blank flash */}
                  <div className="bg-stone-50 border border-stone-200 p-4 rounded-2xl space-y-2.5 text-left text-xs">
                    <div className="flex justify-between items-center">
                      <span className="text-stone-400">Order ID:</span>
                      <div className="h-3.5 bg-stone-200 rounded animate-pulse w-28" />
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-stone-400">Status:</span>
                      <div className="h-3.5 bg-amber-200/70 rounded animate-pulse w-24" />
                    </div>
                    <div className="border-t border-stone-200 pt-2 flex justify-between items-center">
                      <span className="text-stone-400">Total:</span>
                      <div className="h-4 bg-stone-200 rounded animate-pulse w-16" />
                    </div>
                  </div>

                  <div className="flex items-center justify-center space-x-1.5 text-xs text-stone-400 pt-1">
                    <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </>
              )}

              {/* State 2: Payment Success */}
              {!isVerifying && (paymentVerificationResult === 'success' || placedOrder?.paymentStatus === 'completed') && (
                <>
                  <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center mx-auto text-emerald-600">
                    <CheckCircle className="w-9 h-9" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-serif text-xl font-bold text-stone-950">
                      Thanks for ordering {globalSettings?.restaurantName ? `from ${globalSettings.restaurantName}` : "with us"}!
                    </h3>
                    <p className="text-xs text-stone-500">
                      Your payment was successful and your order is being prepared.
                    </p>
                  </div>

                  {/* Summary Card */}
                  <div className="bg-stone-50 border border-stone-200 p-4 rounded-2xl text-xs space-y-2 text-left text-stone-600">
                    <div className="flex justify-between items-center">
                      <span className="text-stone-500">Order Reference:</span>
                      <strong className="text-stone-950 font-mono text-[11px]">#{placedOrder?.id ? placedOrder.id.slice(-8).toUpperCase() : (activeOrderId || '').slice(-8).toUpperCase()}</strong>
                    </div>
                    {placedOrder?.customerName && (
                      <div className="flex justify-between">
                        <span className="text-stone-500">Customer:</span>
                        <strong className="text-stone-950">{placedOrder.customerName}</strong>
                      </div>
                    )}
                    <div className="flex justify-between items-center">
                      <span className="text-stone-500">Payment Status:</span>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 uppercase tracking-wide">
                        PAID
                      </span>
                    </div>
                    {placedOrder?.total != null && (
                      <div className="border-t border-stone-200 pt-2 flex justify-between font-bold text-stone-950 text-xs">
                        <span>Total:</span>
                        <span className="font-mono text-emerald-700 font-bold">{placedOrder.total.toFixed(2)} ETB</span>
                      </div>
                    )}
                  </div>

                  {placedOrder?.shipdayTrackingLink && (
                    <div className="bg-blue-50 border border-blue-100 p-3.5 rounded-2xl flex flex-col items-center">
                      <Truck className="w-6 h-6 text-blue-600 mb-1.5" />
                      <h4 className="text-xs font-bold text-blue-900">Track Your Delivery</h4>
                      <p className="text-[10px] text-blue-600 mb-2.5 text-center">Your order has been dispatched! Track your driver in real-time below.</p>
                      <a
                        href={safeHttpsUrl(placedOrder.shipdayTrackingLink)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded-xl text-xs uppercase tracking-wider text-center transition-colors"
                      >
                        Open Live Tracker
                      </a>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
                    {placedOrder && (
                      <button
                        onClick={() => setSelectedReceiptOrder(placedOrder)}
                        className="flex-1 bg-stone-100 hover:bg-stone-200 text-stone-800 font-bold py-3 px-3 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer flex items-center justify-center space-x-1"
                      >
                        <ReceiptText className="h-4 w-4" />
                        <span>Receipt</span>
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setIsOrderModalOpen(false);
                        setActiveOrderId(null);
                        setPlacedOrder(null);
                        setPaymentVerificationResult(null);
                        localStorage.removeItem('activeOrderId');
                        setIsMyOrdersOpen(true);
                      }}
                      className="flex-1 bg-stone-900 hover:bg-stone-800 text-white font-bold py-3 px-3 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                    >
                      My Orders
                    </button>
                    <button
                      onClick={() => {
                        setIsOrderModalOpen(false);
                        setActiveOrderId(null);
                        setPlacedOrder(null);
                        setPaymentVerificationResult(null);
                        localStorage.removeItem('activeOrderId');
                      }}
                      className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 px-3 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                    >
                      Done
                    </button>
                  </div>
                </>
              )}

              {/* State 3: Payment Failed / Cancelled */}
              {!isVerifying && (paymentVerificationResult === 'failed' || placedOrder?.failureDefinitive === true || placedOrder?.paymentAttemptStatus === 'cancelled' || placedOrder?.paymentStatus === 'failed' || placedOrder?.status === 'cancelled') && (
                <>
                  <div className="w-16 h-16 bg-rose-50 rounded-full flex items-center justify-center mx-auto text-rose-600">
                    <CircleX className="w-9 h-9" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-serif text-xl font-bold text-stone-950">
                      Payment Failed
                    </h3>
                    <p className="text-xs text-stone-500">
                      Your payment could not be completed or was cancelled.
                    </p>
                  </div>

                  {placedOrder?.failureReason && (
                    <div className="bg-rose-50 border border-rose-200/60 p-3 rounded-xl text-xs text-rose-700 font-mono text-left">
                      {placedOrder.failureReason}
                    </div>
                  )}

                  <div className="bg-amber-50/60 border border-amber-200/60 p-3.5 rounded-xl text-xs text-stone-700 text-left space-y-1">
                    <p className="font-semibold text-amber-900 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-amber-500" />
                      Order automatically cancelled
                    </p>
                    <p className="text-stone-600 text-[11px] leading-relaxed">
                      We've automatically preserved and restored your cart items so you don't lose your selection. You can review your cart and try paying again anytime.
                    </p>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
                    <button
                      onClick={() => {
                        if (placedOrder?.items && placedOrder.items.length > 0) {
                          setCart(placedOrder.items);
                          try {
                            localStorage.setItem("gourmet_cart", JSON.stringify(placedOrder.items));
                            if (user?.uid) {
                              setDoc(doc(db, "carts", user.uid), { items: placedOrder.items, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
                            }
                          } catch (e) {}
                        }
                        setIsOrderModalOpen(false);
                        setActiveOrderId(null);
                        setPlacedOrder(null);
                        setPaymentVerificationResult(null);
                        localStorage.removeItem('activeOrderId');
                        setIsCartOpen(true);
                      }}
                      className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 px-4 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer shadow-md flex items-center justify-center gap-2"
                    >
                      <ShoppingCart className="h-4 w-4" />
                      <span>Review Cart & Try Again</span>
                    </button>
                    <button
                      onClick={() => {
                        setIsOrderModalOpen(false);
                        setActiveOrderId(null);
                        setPlacedOrder(null);
                        setPaymentVerificationResult(null);
                        localStorage.removeItem('activeOrderId');
                      }}
                      className="bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold py-3 px-4 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}

              {/* State 4: Pending / Still Processing */}
              {!isVerifying && paymentVerificationResult === 'pending' && placedOrder?.paymentStatus !== 'completed' && placedOrder?.failureDefinitive !== true && placedOrder?.paymentAttemptStatus !== 'cancelled' && placedOrder?.paymentStatus !== 'failed' && placedOrder?.status !== 'cancelled' && (
                <>
                  <div className="w-16 h-16 bg-amber-50 rounded-full flex items-center justify-center mx-auto text-amber-600">
                    <Clock className="w-9 h-9 animate-pulse" />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="font-serif text-xl font-bold text-stone-950">
                      {placedOrder?.paymentReconciliationRequired ? "Confirming Payment With Chapa" : "Payment Awaiting Confirmation"}
                    </h3>
                    <p className="text-xs text-stone-500">
                      {placedOrder?.paymentReconciliationRequired
                        ? "Chapa sent a success notification but its verification has not agreed yet. We are checking—do not pay again."
                        : "We are waiting for payment confirmation from Chapa."}
                    </p>
                  </div>

                  <div className="bg-stone-50 border border-stone-200 p-4 rounded-2xl text-xs space-y-2 text-left text-stone-600">
                    <div className="flex justify-between items-center">
                      <span className="text-stone-500">Order Reference:</span>
                      <strong className="text-stone-950 font-mono text-[11px]">#{placedOrder?.id ? placedOrder.id.slice(-8).toUpperCase() : (activeOrderId || '').slice(-8).toUpperCase()}</strong>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-stone-500">Status:</span>
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 uppercase">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-600 animate-ping" />
                        {placedOrder?.paymentReconciliationRequired ? "Reconciling" : "Awaiting Confirmation"}
                      </span>
                    </div>
                    {placedOrder?.total != null && (
                      <div className="border-t border-stone-200 pt-2 flex justify-between font-bold text-stone-950 text-xs">
                        <span>Total:</span>
                        <span className="font-mono text-amber-700 font-bold">{placedOrder.total.toFixed(2)} ETB</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 pt-2">
                    <button
                      disabled={isVerifying}
                      onClick={() => {
                        const targetId = activeOrderId || placedOrder?.id;
                        if (targetId) void verifyChapaPayment(targetId, true);
                      }}
                      className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Check Status Again</span>
                    </button>
                    {placedOrder?.chapaCheckoutUrl && !placedOrder?.paymentReconciliationRequired && (
                      <div className="space-y-1">
                        <a
                          href={safeChapaCheckoutUrl(placedOrder.chapaCheckoutUrl)}
                          className="flex w-full items-center justify-center gap-2 bg-[#00A859] hover:bg-[#008f4c] text-white font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-colors text-center cursor-pointer shadow-sm"
                        >
                          <span>Continue to Payment</span>
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          setIsOrderModalOpen(false);
                          setIsMyOrdersOpen(true);
                        }}
                        className="flex-1 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                      >
                        My Orders
                      </button>
                      <button
                        onClick={async () => {
                          confirmDialog("Are you sure you want to cancel this order?", async () => {
                            const targetId = activeOrderId || placedOrder?.id;
                            if (targetId) {
                              try {
                                const cancelResponse = await authedFetch(`/api/orders/${encodeURIComponent(targetId)}/cancel`, { method: "POST" });
                                const cancelData = await cancelResponse.json().catch(() => ({}));
                                if (!cancelResponse.ok) throw new Error(formatCheckoutError(cancelData));
                                if (placedOrder?.items && placedOrder.items.length > 0) {
                                  setCart(placedOrder.items);
                                  localStorage.setItem("gourmet_cart", JSON.stringify(placedOrder.items));
                                }
                                setIsOrderModalOpen(false);
                                setActiveOrderId(null);
                                setPlacedOrder(null);
                                setPaymentVerificationResult(null);
                                localStorage.removeItem('activeOrderId');
                                toastSuccess(cancelData.order?.status === "cancel_requested"
                                  ? "Cancellation is still being confirmed. You can retry it from My Orders."
                                  : "Order cancelled. Your cart items were restored.");
                              } catch (error) {
                                toastError(formatCheckoutError(error));
                              }
                            }
                          }, null, "Cancel Order");
                        }}
                        className="flex-1 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                      >
                        Cancel Order
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* My Orders Modal overlay */}
        {isMyOrdersOpen && (
          <div id="my-orders-modal" className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs" onClick={() => setIsMyOrdersOpen(false)}>
            <div className="bg-white rounded-3xl max-w-lg w-full max-h-[80vh] flex flex-col shadow-2xl border border-stone-100 animate-scale-up font-sans" onClick={e => e.stopPropagation()}>
              <div className="p-6 border-b border-stone-100 flex items-center justify-between bg-stone-50 rounded-t-3xl">
                <div className="flex items-center space-x-2.5">
                  <ClipboardList className="w-5 h-5 text-stone-800" />
                  <h3 className="font-serif text-lg font-bold text-stone-900">My Orders</h3>
                </div>
                <button
                  onClick={() => setIsMyOrdersOpen(false)}
                  className="p-1 text-stone-400 hover:text-stone-800 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 overflow-y-auto flex-grow space-y-6 max-h-[60vh]">
                {isMyOrdersLoading ? (
                  <div className="space-y-4 py-2">
                    <div className="flex items-center justify-center space-x-2 text-amber-700 py-4">
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-600 animate-ping" />
                      <span className="text-xs font-semibold uppercase tracking-wider">Loading Orders...</span>
                    </div>
                    {[1, 2, 3].map(i => (
                      <div key={i} className="animate-pulse bg-stone-50 border border-stone-200/60 rounded-xl p-4 space-y-3">
                        <div className="flex justify-between items-center">
                          <div className="space-y-1.5">
                            <div className="h-2.5 bg-stone-200 rounded w-16" />
                            <div className="h-3.5 bg-stone-200 rounded w-28" />
                          </div>
                          <div className="h-5 bg-stone-200 rounded-full w-20" />
                        </div>
                        <div className="h-3 bg-stone-200 rounded w-3/4" />
                        <div className="flex justify-between items-center pt-2 border-t border-stone-100">
                          <div className="h-3 bg-stone-200 rounded w-24" />
                          <div className="h-3 bg-stone-200 rounded w-16" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : myOrders.length === 0 ? (
                  <div className="text-center py-10 text-stone-400">
                    <ClipboardList className="w-12 h-12 mx-auto mb-3 stroke-1 text-stone-300" />
                    <p className="text-sm font-medium">You haven't placed any orders yet.</p>
                  </div>
                ) : (
                  Object.entries(groupOrdersByDate(myOrders)).map(([dateGroup, groupOrders]) => (
                    <div key={dateGroup} className="space-y-3">
                      <div className="sticky top-0 z-10 bg-stone-100/95 backdrop-blur-md py-1.5 px-3 rounded-lg text-[10px] font-bold text-stone-600 tracking-wider uppercase flex justify-between items-center border border-stone-200/50 shadow-xs">
                        <span>{dateGroup}</span>
                        <span className="bg-stone-200 text-stone-700 px-2 py-0.5 rounded-full font-mono text-[9px]">
                          {groupOrders.length} {groupOrders.length === 1 ? 'order' : 'orders'}
                        </span>
                      </div>
                      <div className="space-y-3">
                        {groupOrders.map(order => {
                          const isPendingAndUnpaid = order.paymentStatus !== 'completed' && ['pending', 'cancel_requested'].includes(order.status);
                          const isCurrentlyExpanded = expandedMyOrderId === order.id;

                          return (
                            <div
                              key={order.id}
                              onClick={() => {
                                if (isPendingAndUnpaid) {
                                  setOrderActionModal(order);
                                } else {
                                  setExpandedMyOrderId(isCurrentlyExpanded ? null : order.id);
                                }
                              }}
                              className={`border p-4 rounded-xl space-y-2 transition-all duration-200 ${isPendingAndUnpaid
                                ? 'cursor-pointer hover:border-amber-400 hover:shadow-xs bg-amber-50/10 border-amber-200/60'
                                : 'bg-stone-50 border-stone-200 cursor-pointer'
                                }`}
                            >
                              <div className="flex justify-between items-start">
                                <div>
                                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Order ID</span>
                                  <span className="font-mono text-xs font-bold">{order.id}</span>
                                </div>
                                <div className="flex flex-col items-end space-y-1">
                                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${order.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                                    order.status === 'preparing' ? 'bg-amber-100 text-amber-800' :
                                      'bg-stone-200 text-stone-800'
                                    }`}>
                                    {order.status === 'cancel_requested' ? 'CANCELLING' : order.status}
                                  </span>
                                  <span
                                    onClick={(e) => {
                                      if (order.paymentStatus === 'completed') {
                                        e.stopPropagation();
                                        setSelectedReceiptOrder(order);
                                      }
                                    }}
                                    className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase flex items-center gap-0.5 ${order.paymentStatus === 'completed'
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-pointer hover:bg-emerald-100 transition-colors'
                                      : order.paymentStatus === 'failed' || order.failureDefinitive === true
                                        ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                        : order.paymentAttemptStatus === 'cancelled' || order.status === 'cancelled'
                                          ? 'bg-stone-100 text-stone-600 border border-stone-200'
                                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                                      }`}
                                    title={order.paymentStatus === 'completed' ? "Click to view receipt" : undefined}
                                  >
                                    {order.paymentStatus === 'completed' ? (
                                      <>
                                        <span>PAID ✅</span>
                                        <span className="underline opacity-80 text-[8px] font-medium ml-0.5">Receipt</span>
                                      </>
                                    ) : order.paymentStatus === 'failed' || order.failureDefinitive === true ? (
                                      <span>FAILED ❌</span>
                                    ) : order.paymentAttemptStatus === 'cancelled' || order.status === 'cancelled' ? (
                                      <span>CANCELLED</span>
                                    ) : (
                                      <span className="flex items-center gap-1.5 text-amber-700">
                                        <span>{order.paymentAttemptStatus === 'reconciling' || order.paymentAttemptStatus === 'initializing' || order.status === 'cancel_requested' ? 'CHECKING PAYMENT' : 'AWAITING PAYMENT'}</span>
                                      </span>
                                    )}
                                  </span>
                                </div>
                              </div>

                              <div className="pt-2 border-t border-stone-200">
                                {order.items.map((item, idx) => (
                                  <div key={idx} className="flex justify-between text-xs py-1">
                                    <span className="text-stone-700">
                                      {item.quantity}x {item.menuItem?.id ? (
                                        <Link to={`/food/${item.menuItem.id}`} onClick={() => setIsMyOrdersOpen(false)} className="hover:text-amber-700 hover:underline">{item.menuItem.name}</Link>
                                      ) : (
                                        item.menuItem?.name || "Dish"
                                      )}
                                      {item.menuItem?.variation?.label && (
                                        <span className="text-stone-400"> ({item.menuItem.variation.label})</span>
                                      )}
                                    </span>
                                    <span className="font-mono font-medium text-stone-900">{((item.menuItem?.price || 0) * item.quantity).toFixed(2)} ETB</span>
                                  </div>
                                ))}
                              </div>

                              {order.specialInstructions && (
                                <div className="bg-amber-50/50 p-2 rounded border border-amber-100/50 mt-1">
                                  <span className="text-[9px] font-bold uppercase tracking-wider text-amber-700 block mb-0.5">Instructions</span>
                                  <p className="text-[11px] text-stone-600 italic">"{order.specialInstructions}"</p>
                                </div>
                              )}

                              {(order.blockNumber || order.roomNumber || order.googleMapsAddress) && (
                                <div className="bg-stone-100/50 p-2 rounded border border-stone-200/50 mt-1">
                                  <span className="text-[9px] font-bold uppercase tracking-wider text-stone-500 block mb-0.5">Delivery Address</span>
                                  <div className="text-[11px] text-stone-800 space-y-0.5">
                                    {order.blockNumber && <div><span className="text-stone-500">Block:</span> {order.blockNumber}</div>}
                                    {order.roomNumber && <div><span className="text-stone-500">Room:</span> {order.roomNumber}</div>}
                                    {order.googleMapsAddress && <div><span className="text-stone-500">Address:</span> {order.googleMapsAddress}</div>}
                                  </div>
                                </div>
                              )}

                              <div className="flex justify-between items-center pt-2 mt-2 border-t border-stone-200 text-sm">
                                <span className="font-bold text-stone-900">Total</span>
                                <span className="font-mono font-bold text-amber-700">{order.total.toFixed(2)} ETB</span>
                              </div>

                              {order.shipdayTrackingLink && (
                                <div className="pt-2">
                                  <a
                                    href={safeHttpsUrl(order.shipdayTrackingLink)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded-lg text-[10px] uppercase tracking-wider text-center transition-colors flex items-center justify-center space-x-2"
                                  >
                                    <Truck className="w-3.5 h-3.5" />
                                    <span>Track Delivery</span>
                                  </a>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Order Action Modal for Pay/Cancel */}
        {orderActionModal && (
          <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4 backdrop-blur-md" onClick={() => setOrderActionModal(null)}>
            <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-stone-200 animate-scale-up font-sans text-center space-y-4" onClick={e => e.stopPropagation()}>
              <div className="mx-auto w-12 h-12 bg-amber-50 rounded-full flex items-center justify-center text-amber-600">
                <ClipboardList className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-serif text-lg font-bold text-stone-900">Manage Order</h3>
                <p className="font-mono text-xs text-stone-500 mt-1">Order ID: {orderActionModal.id}</p>
                <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                  {orderActionModal.status === 'cancel_requested'
                    ? "We’re confirming cancellation with Chapa. You can retry cancelling this payment while it remains pending."
                    : orderActionModal.paymentReconciliationRequired
                    ? "Chapa sent a success notification but verification is still inconsistent. Check the payment status; do not start another payment yet."
                    : "This order is waiting for payment. Would you like to pay online now or cancel this order?"}
                </p>
              </div>

              <div className="space-y-2.5 pt-2">
                {orderActionModal.status !== 'cancel_requested' && <button
                  onClick={() => {
                    setActiveOrderId(orderActionModal.id);
                    localStorage.setItem('activeOrderId', orderActionModal.id);
                    setIsMyOrdersOpen(false);
                    const selectedOrder = orderActionModal;
                    const alreadyActive = activeOrderId === selectedOrder.id;
                    const chapaUrl = safeChapaCheckoutUrl(selectedOrder.chapaCheckoutUrl);
                    setOrderActionModal(null);
                    if (selectedOrder.paymentReconciliationRequired) {
                      setIsOrderModalOpen(true);
                      if (alreadyActive) void verifyChapaPayment(selectedOrder.id, true);
                    } else if (chapaUrl) {
                      window.location.href = chapaUrl;
                    } else {
                      toastError("This order has no valid checkout link. Check its payment status before trying again.");
                    }
                  }}
                  className="w-full bg-[#00A859] hover:bg-[#008f4c] text-white font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-colors shadow-md cursor-pointer flex items-center justify-center space-x-2.5"
                >
                  <div className="bg-white p-0.5 rounded-md flex items-center justify-center shadow-2xs">
                    <ChapaLogoSVG className="w-4 h-4 flex-shrink-0" />
                  </div>
                  <span>{orderActionModal.paymentReconciliationRequired ? "Check Payment Status" : "Pay Now"}</span>
                </button>}

                <button
                  onClick={async () => {
                    confirmDialog("Are you sure you want to cancel this order?", async () => {
                      try {
                        const response = await authedFetch(`/api/orders/${encodeURIComponent(orderActionModal.id)}/cancel`, { method: "POST" });
                        const data = await response.json().catch(() => ({}));
                        if (!response.ok) throw new Error(formatCheckoutError(data));
                        if (activeOrderId === orderActionModal.id) {
                          setPlacedOrder(null);
                          localStorage.removeItem('activeOrderId');
                          setActiveOrderId(null);
                        }
                        setOrderActionModal(null);
                        toastSuccess(data.order?.status === "cancel_requested"
                          ? "Cancellation is still being confirmed. You can retry it from My Orders."
                          : "Order cancelled.");
                      } catch (err) {
                        toastError(formatCheckoutError(err));
                      }
                    }, null, "Cancel Order");
                  }}
                  className="w-full bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                >
                  {orderActionModal.status === 'cancel_requested' ? 'Retry Payment Cancellation' : 'Cancel Order'}
                </button>

                <button
                  onClick={() => setOrderActionModal(null)}
                  className="w-full bg-stone-100 hover:bg-stone-200 text-stone-700 font-medium py-3 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                >
                  Keep Order
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Expanded Product Modal */}
        {expandedProduct && (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={handleCloseProductModal}>
            <div
              className="bg-white rounded-3xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl animate-scale-up"
              onClick={e => e.stopPropagation()}
            >
              {(() => {
                const allImages = [expandedProduct.image, ...normalizeGalleryImages(expandedProduct.galleryImages)];
                return (
                  <div className="relative h-64 md:h-80 w-full bg-stone-100 flex flex-col group">
                    <img
                      src={allImages[activeImageIndex] || expandedProduct.image}
                      alt={expandedProduct.name}
                      className="w-full h-full object-cover"
                    />
                    {allImages.length > 1 && (
                      <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-2 px-4">
                        {allImages.map((img, idx) => (
                          <button
                            key={idx}
                            onClick={() => setActiveImageIndex(idx)}
                            className={`w-14 h-14 rounded-xl border-2 overflow-hidden shadow-lg transition-all ${activeImageIndex === idx ? 'border-amber-500 scale-110' : 'border-white opacity-70 hover:opacity-100'}`}
                          >
                            <img src={img} alt="thumbnail" className="w-full h-full object-cover" />
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={handleCloseProductModal}
                      className="absolute top-4 right-4 bg-black/50 hover:bg-black text-white p-2 rounded-full backdrop-blur-md transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                );
              })()}

              {(() => {
                const modalVariations = itemVariations(expandedProduct);
                const selectedVariation =
                  expandedVariationId
                    ? modalVariations.find(v => String(v.id) === String(expandedVariationId)) || null
                    : null;
                const modalUnitPrice = selectedVariation ? variationPrice(selectedVariation) : (Number(expandedProduct.price) || 0);
                const anyAvailable = modalVariations.length === 0 || modalVariations.some(v => isVariationAvailable(v));
                return (
                  <div className="p-6 md:p-8 space-y-6">
                <div>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {expandedProduct.popular && (
                      <span className="bg-amber-500 text-stone-950 text-[10px] font-bold px-2 py-0.5 rounded-md font-mono tracking-wide uppercase flex items-center shadow-sm">
                        <Star className="w-3.5 h-3.5 mr-1 fill-current" />
                        Popular
                      </span>
                    )}
                    {expandedProduct.promoStickers?.map(sticker => (
                      <span key={sticker} className="bg-stone-900 text-white text-[10px] font-bold px-2 py-0.5 rounded-md font-mono tracking-wide uppercase shadow-sm">
                        {sticker}
                      </span>
                    ))}
                  </div>

                  <div className="flex justify-between items-start gap-4">
                    <h2 className="font-serif text-2xl md:text-3xl font-bold text-stone-900 leading-tight">
                      {expandedProduct.name}
                    </h2>
                    <div className="text-right shrink-0">
                      <span className="font-mono text-xl font-bold text-amber-700 block">{modalUnitPrice.toFixed(2)} ETB</span>
                    </div>
                  </div>

                  <p className="mt-4 text-stone-600 leading-relaxed text-sm md:text-base">
                    {expandedProduct.description}
                  </p>
                </div>

                {modalVariations.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-stone-900">Choose an Option</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {modalVariations.map(v => {
                        const available = isVariationAvailable(v);
                        const selected = !!selectedVariation && String(selectedVariation.id) === String(v.id);
                        return (
                          <button
                            key={v.id}
                            type="button"
                            disabled={!available}
                            onClick={() => setExpandedVariationId(String(v.id))}
                            className={`relative text-left border rounded-xl px-3 py-2.5 transition-all ${!available
                              ? 'border-stone-200 bg-stone-50 opacity-60 cursor-not-allowed'
                              : selected
                                ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500/30'
                                : 'border-stone-300 bg-white hover:border-amber-400 hover:bg-amber-50/40 cursor-pointer'
                              }`}
                          >
                            
                            <span className={`block text-sm font-bold ${selected ? 'text-amber-900' : 'text-stone-900'}`}>{v.label}</span>
                            <span className="block text-[11px] font-mono font-semibold text-amber-700 mt-0.5">{variationPrice(v).toFixed(2)} ETB</span>
                            {!available && (
                              <span className="absolute bottom-0 inset-x-0 rounded-b-xl bg-rose-50 text-rose-500 text-[8px] font-bold text-center py-0.5 uppercase tracking-wide">Unavailable</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {!anyAvailable && (
                      <p className="text-[11px] text-rose-600 font-semibold">All options are currently unavailable.</p>
                    )}
                  </div>
                )}

                {expandedProduct.ingredients && expandedProduct.ingredients.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-stone-900">Ingredients</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {expandedProduct.ingredients.map((ing, idx) => (
                        <span key={idx} className="bg-stone-50 border border-stone-200 text-stone-600 text-xs px-2.5 py-1 rounded-lg">
                          {ing}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Action Bar */}
                <div className="pt-6 border-t border-stone-100 flex flex-col sm:flex-row items-center gap-4">
                  <div className="flex items-center space-x-4 bg-stone-50 border border-stone-200 rounded-xl p-1 w-full sm:w-auto justify-center">
                    <button
                      aria-label="Decrease quantity"
                      onClick={() => setExpandedQuantity(Math.max(1, expandedQuantity - 1))}
                      className="w-10 h-10 flex items-center justify-center text-stone-500 hover:text-stone-900 hover:bg-stone-200 rounded-lg transition-colors font-mono text-lg"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="font-mono font-bold text-stone-900 w-4 text-center">{expandedQuantity}</span>
                    <button
                      aria-label="Increase quantity"
                      onClick={() => setExpandedQuantity(expandedQuantity + 1)}
                      className="w-10 h-10 flex items-center justify-center text-stone-500 hover:text-stone-900 hover:bg-stone-200 rounded-lg transition-colors font-mono text-lg"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>

                  <button
                    disabled={!isOpen || !anyAvailable}
                    onClick={() => {
                      const variation = selectedVariation || undefined;
                      for (let i = 0; i < expandedQuantity; i++) {
                        addToCart(expandedProduct, variation);
                      }
                      handleCloseProductModal();
                    }}
                    className={`flex-grow font-bold py-3.5 px-6 rounded-xl transition-colors w-full flex justify-between items-center text-sm tracking-wide shadow-md ${isOpen && anyAvailable ? 'bg-stone-900 hover:bg-amber-600 text-white cursor-pointer' : 'bg-stone-300 text-stone-500 cursor-not-allowed'
                      }`}
                  >
                    <span className="uppercase">{isOpen ? (anyAvailable ? 'Add to Order' : 'Unavailable') : 'Closed'}</span>
                    {isOpen && anyAvailable && <span className="font-mono bg-white/20 px-2 py-1 rounded">{(modalUnitPrice * expandedQuantity).toFixed(2)} ETB</span>}
                  </button>
                </div>

                {/* Reviews Section */}
                <div className="mt-8">
                  <ItemReviews menuItemId={expandedProduct.id} user={user} />
                </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="bg-stone-900 text-stone-400 py-12 mt-12 border-t border-stone-800 font-sans">
          <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="md:col-span-1">
              <span className="font-serif text-lg font-bold text-white tracking-tight">About</span>
              <p className="text-xs mt-2 leading-relaxed">
                We are an located in Addis Ababa Science and Technology University, Ethiopia. We specialize in
                offering a range of traditional Ethiopian dishes, made with fresh and high-quality
                ingredients. Our menu features a variety of vegetarian and meat options, all prepared
                with authentic Ethiopian spices and flavors. Whether you're looking for a quick meal or a
                place to relax and enjoy a good meal, we have something for everyone.
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-widest text-white">CONTACT US</h4>
              <div className="text-xs leading-relaxed space-y-1.5">
                {globalSettings?.businessEmail && (
                  <div className="flex items-center space-x-2">
                    <Mail className="w-3 h-3 text-amber-500 flex-shrink-0" />
                    <a href={`mailto:${globalSettings.businessEmail}`} className="hover:text-white transition-colors break-all">
                      {globalSettings.businessEmail}
                    </a>
                  </div>
                )}
                {globalSettings?.businessPhone && (
                  <div className="flex items-center space-x-2">
                    <Phone className="w-3 h-3 text-amber-500 flex-shrink-0" />
                    <a href={`tel:${globalSettings.businessPhone}`} className="hover:text-white transition-colors">
                      {globalSettings.businessPhone}
                    </a>
                  </div>
                )}
                {!globalSettings?.businessEmail && !globalSettings?.businessPhone && (
                  <p className="text-stone-500 italic">Add contact info in admin settings.</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-widest text-white">Location</h4>
              <div className="text-xs leading-relaxed font-sans flex items-start space-x-2">
                {globalSettings?.businessAddress && (
                  <>
                    <MapPin className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" />
                    <span>{globalSettings.businessAddress}</span>
                  </>
                )}
                {!globalSettings?.businessAddress && (
                  <p className="text-stone-500 italic">Add your address in admin settings.</p>
                )}
              </div>
            </div>
            <div className="space-y-3 md:col-span-1">
              <h4 className="text-xs font-bold uppercase tracking-widest text-white">Newsletter</h4>
              <p className="text-xs leading-relaxed">Subscribe to get special offers, free giveaways, and once-in-a-lifetime deals.</p>
              <form onSubmit={handleSubscribe} className="flex flex-col space-y-2">
                <input
                  type="email"
                  value={subscribeEmail}
                  onChange={(e) => setSubscribeEmail(e.target.value)}
                  placeholder="Enter your email address"
                  required
                  className="w-full text-xs px-3 py-2 bg-stone-800 border border-stone-700 text-white rounded-lg focus:outline-none focus:border-amber-500 transition-colors"
                />
                <button
                  type="submit"
                  disabled={subscribeStatus === 'loading'}
                  className="w-full text-xs font-bold bg-amber-600 hover:bg-amber-500 text-white px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {subscribeStatus === 'loading' ? 'Subscribing...' : subscribeStatus === 'success' ? 'Subscribed!' : 'Subscribe'}
                </button>
                {subscribeStatus === 'error' && <p className="text-[10px] text-red-400">{subscribeErrorMsg}</p>}
              </form>
            </div>
          </div>
          <div className="max-w-7xl mx-auto px-6 mt-8 pt-6 border-t border-stone-800 text-center text-xs text-stone-500">
            © {new Date().getFullYear()} {businessName} • All rights reserved.
          </div>
        </footer>
        {globalSettings?.enableChatbot !== false && user && <Chatbot userId={user.uid} />}

        {/* Reservation Drawer Overlay */}
        {isReservationOpen && (
          <div className="fixed inset-0 bg-black/45 z-50 flex justify-center items-center backdrop-blur-xs p-4" onClick={() => setIsReservationOpen(false)}>
            <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden animate-scale-up font-sans" onClick={e => e.stopPropagation()}>
              <div className="p-5 border-b border-stone-100 flex items-center justify-between bg-stone-50">
                <div className="flex items-center space-x-2.5">
                  <CalendarDays className="w-5 h-5 text-stone-800" />
                  <h3 className="font-serif text-lg font-bold text-stone-900">Book a Table</h3>
                </div>
                <button
                  onClick={() => setIsReservationOpen(false)}
                  className="p-1 text-stone-400 hover:text-stone-800 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleReservationSubmit} className="p-6 space-y-4">
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-stone-700 mb-1">Date</label>
                      <input
                        type="date"
                        required
                        min={new Date().toISOString().split('T')[0]}
                        value={reservationForm.date}
                        onChange={(e) => setReservationForm({ ...reservationForm, date: e.target.value })}
                        className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-stone-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-stone-700 mb-1">Time</label>
                      <input
                        type="time"
                        required
                        value={reservationForm.time}
                        onChange={(e) => setReservationForm({ ...reservationForm, time: e.target.value })}
                        className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-stone-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-stone-700 mb-1">Party Size</label>
                    <select
                      value={reservationForm.partySize}
                      onChange={(e) => setReservationForm({ ...reservationForm, partySize: parseInt(e.target.value) })}
                      className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-stone-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                        <option key={n} value={n}>{n} {n === 1 ? 'Person' : 'People'}</option>
                      ))}
                      <option value={11}>More than 10</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-stone-700 mb-1">Special Requests (Optional)</label>
                    <textarea
                      value={reservationForm.notes}
                      onChange={(e) => setReservationForm({ ...reservationForm, notes: e.target.value })}
                      placeholder="Any allergies, special requests, etc."
                      rows={2}
                      className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-stone-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>

                  {!user && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start space-x-2 mt-4">
                      <User className="w-4 h-4 shrink-0 mt-0.5" />
                      <p>Please log in from the main menu before making a reservation so we can associate it with your profile.</p>
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-stone-100 flex justify-end">
                  <button
                    type="submit"
                    disabled={isSubmittingReservation || !user}
                    className="bg-stone-900 hover:bg-amber-600 text-white font-bold py-2.5 px-6 rounded-xl transition-colors disabled:opacity-50 text-sm flex items-center space-x-2 cursor-pointer"
                  >
                    {isSubmittingReservation ? (
                      <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                    ) : (
                      <CheckCircle className="w-4 h-4" />
                    )}
                    <span>{isSubmittingReservation ? 'Requesting...' : 'Request Booking'}</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </APIProvider>
  );
}

export default function App() {
  useEffect(() => onSnapshot(doc(db, "settings", "global"), snapshot => {
    document.title = getRestaurantName(snapshot.exists() ? snapshot.data()?.restaurantName : undefined);
  }, () => { document.title = "Restaurant"; }), []);

  return (
    <Routes>
      <Route path="/admin/*" element={
        <React.Suspense fallback={<div className="min-h-screen grid place-items-center text-stone-500">Loading admin…</div>}>
          <AdminPortal />
        </React.Suspense>
      } />
      <Route path="*" element={<MainApp />} />
    </Routes>
  );
}
