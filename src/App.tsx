/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { Routes, Route, useNavigate, useParams, Link, useLocation } from "react-router-dom";
import { MenuItem, Order, OrderItem } from "./types";
import AdminPortal from "./AdminPortal";
import {
  Utensils,
  ShoppingCart,
  X,
  CheckCircle,
  ArrowRight,
  ChevronRight,
  ClipboardList,
  Trash2,
  Lock,
  Clock,
  Settings,
  Star,
  Search,
  LogOut,
  User,
  RotateCcw,
  ChevronDown,
  Truck,
  Heart,
  CalendarDays
} from "lucide-react";
import { db, auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged } from "./firebase";
import { collection, onSnapshot, doc, query, where, setDoc, getDoc, deleteDoc } from "firebase/firestore";
import { APIProvider } from "@vis.gl/react-google-maps";
import GoogleMapsAddressInput from "./components/GoogleMapsAddressInput";
import Chatbot from "./components/Chatbot";
import ItemReviews from "./components/ItemReviews";
// @ts-ignore
import chapaLogoImg from "./images.png";

const API_KEY = process.env.GOOGLE_MAPS_PLATFORM_KEY || (import.meta as any).env?.VITE_GOOGLE_MAPS_PLATFORM_KEY || "";

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
      alt="Chapa"
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
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Auth state
  const [user, setUser] = useState<any>(null);
  const [isGuest, setIsGuest] = useState(false);
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

  // Promo Code & Loyalty State
  const [promoCodeInput, setPromoCodeInput] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<any>(null);
  const [promoError, setPromoError] = useState("");
  const [usePoints, setUsePoints] = useState(false);

  const [expandedProduct, setExpandedProduct] = useState<MenuItem | null>(null);
  const [expandedQuantity, setExpandedQuantity] = useState(1);
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const match = location.pathname.match(/^\/food\/(.+)/);
    if (match) {
      const foodId = match[1];
      const food = menu.find(m => m.id === foodId);
      if (food) {
        setExpandedProduct(food);
      }
    } else {
      if (expandedProduct && location.pathname === "/") {
        setExpandedProduct(null);
      }
    }
  }, [location.pathname, menu]);

  const handleCloseProductModal = () => {
    setExpandedProduct(null);
    navigate("/");
  };

  // Success Order Overlay
  const [placedOrder, setPlacedOrder] = useState<Order | null>(null);
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<Order | null>(null);
  const [chapaCheckoutUrl, setChapaCheckoutUrl] = useState<string | null>(() => localStorage.getItem('chapaCheckoutUrl'));
  const [checkoutSettings, setCheckoutSettings] = useState({
    serviceTaxPercent: 15,
    flatFeeETB: 0,
    isOpen: true,
    enableCOD: true
  });

  const [globalSettings, setGlobalSettings] = useState<any>(null);

  const [subscribeEmail, setSubscribeEmail] = useState("");
  const [subscribeStatus, setSubscribeStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [subscribeErrorMsg, setSubscribeErrorMsg] = useState("");

  const handleSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subscribeEmail) return;
    setSubscribeStatus("loading");
    setSubscribeErrorMsg("");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: subscribeEmail })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to subscribe");

      setSubscribeStatus("success");
      setSubscribeEmail("");
      setTimeout(() => setSubscribeStatus("idle"), 3000);
    } catch (err: any) {
      console.error("Subscription failed:", err);
      setSubscribeStatus("error");
      setSubscribeErrorMsg(err.message || "Subscription failed. Please try again.");
    }
  };

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, "settings", "checkout"), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setCheckoutSettings({
          serviceTaxPercent: data.serviceTaxPercent !== undefined ? data.serviceTaxPercent : 15,
          flatFeeETB: data.flatFeeETB !== undefined ? data.flatFeeETB : 0,
          isOpen: data.isOpen !== undefined ? data.isOpen : true,
          enableCOD: data.enableCOD !== undefined ? data.enableCOD : true
        });
      } else {
        setCheckoutSettings({ serviceTaxPercent: 15, flatFeeETB: 0, isOpen: true, enableCOD: true });
      }
    }, (error) => {
      console.error("Failed to subscribe to checkout settings", error);
    });

    const unsubscribeGlobal = onSnapshot(doc(db, "settings", "global"), (docSnap) => {
      if (docSnap.exists()) {
        setGlobalSettings(docSnap.data());
      }
    }, (error) => {
      console.error("Failed to subscribe to global settings", error);
    });

    return () => {
      unsubscribe();
      unsubscribeGlobal();
    };
  }, []);

  const [activeOrderId, setActiveOrderId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const txRef = params.get('tx_ref');
    if (txRef) {
      localStorage.setItem('activeOrderId', txRef);
      return txRef;
    }
    return localStorage.getItem('activeOrderId');
  });
  const [isVerifying, setIsVerifying] = useState(false);

  useEffect(() => {
    // Auth Listener
    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
      if (currentUser) {
        if (!localStorage.getItem("lastCheckoutName")) {
          setCustomerName(currentUser.displayName || "");
        }
        if (!localStorage.getItem("lastCheckoutEmail")) {
          setCustomerEmail(currentUser.email || "");
        }

        try {
          const userDocRef = doc(db, "users", currentUser.uid);
          const userDocSnap = await getDoc(userDocRef);

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
            setUserProfile(newProfile);
          } else {
            setUserProfile(userDocSnap.data());
          }
        } catch (error) {
          console.error("Error loading user profile:", error);
        }

        try {
          const cartDoc = await getDoc(doc(db, "carts", currentUser.uid));
          if (cartDoc.exists()) {
            const dbCart = cartDoc.data().items || [];
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
        } catch (error) {
          console.error("Error loading cart from db:", error);
        }
        setCartLoadedFromDb(true);
      } else {
        setCartLoadedFromDb(false);
      }
    });

    // Real-time Categories Listener
    const unsubscribeCategories = onSnapshot(collection(db, "categories"), (snapshot) => {
      const catData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as { id: string, name: string }));
      setCategories(catData);
    }, (error) => {
      console.error("Failed to sync categories", error);
    });

    // Real-time Menu Listener
    const unsubscribeMenu = onSnapshot(collection(db, "menu"), (snapshot) => {
      const menuData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as MenuItem));
      setMenu(menuData);
    }, (error) => {
      console.error("Failed to sync menu state", error);
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

    // 2. If user is logged in AND their cloud cart has been loaded/merged, sync to Firestore
    if (user && cartLoadedFromDb) {
      setDoc(doc(db, "carts", user.uid), {
        items: cart,
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
      return;
    }

    // Listen to user's orders
    const q = query(
      collection(db, "orders"),
      where("userId", "==", user.uid)
    );

    const unsubscribeMyOrders = onSnapshot(q, (snapshot) => {
      const userOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Order));

      // Auto-delete user orders older than 30 days on the client website (not the admin)
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const expiredOrders = userOrders.filter(order => {
        if (!order.createdAt) return false;
        const orderTime = new Date(order.createdAt).getTime();
        return !isNaN(orderTime) && orderTime < thirtyDaysAgo;
      });

      if (expiredOrders.length > 0) {
        console.log(`[AUTO-CLEANUP] Found ${expiredOrders.length} orders older than 30 days. Deleting automatically...`);
        expiredOrders.forEach(async (order) => {
          try {
            await deleteDoc(doc(db, "orders", order.id));
          } catch (err) {
            console.error("Failed to auto-delete expired order:", order.id, err);
          }
        });
      }

      // Filter out expired orders from local state to prevent UI flickering during deletion
      const validOrders = userOrders.filter(order => {
        if (!order.createdAt) return true;
        const orderTime = new Date(order.createdAt).getTime();
        return isNaN(orderTime) || orderTime >= thirtyDaysAgo;
      });

      // Sort descending by createdAt
      validOrders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setMyOrders(validOrders);
    });
    return () => unsubscribeMyOrders();
  }, [user]);

  useEffect(() => {
    if (!activeOrderId) {
      setPlacedOrder(null);
      return;
    }

    // Trigger backend verification to transition paymentStatus from pending -> completed
    setIsVerifying(true);
    fetch(`/api/chapa/verify/${activeOrderId}`)
      .then(res => res.json())
      .then(data => {
        console.log("[CHAPA VERIFY] Verification result:", data);
      })
      .catch(err => {
        console.error("[CHAPA VERIFY] Verification call failed:", err);
      })
      .finally(() => {
        setIsVerifying(false);
      });

    const unsubscribeOrder = onSnapshot(doc(db, "orders", activeOrderId), (docSnap) => {
      if (docSnap.exists()) {
        const orderData = { id: docSnap.id, ...docSnap.data() } as Order;
        setPlacedOrder(orderData);
        if (orderData.paymentStatus === 'completed') {
          setChapaCheckoutUrl(null);
          localStorage.removeItem('chapaCheckoutUrl');
        }
      } else {
        // Order not found, clear local storage
        localStorage.removeItem('activeOrderId');
        localStorage.removeItem('chapaCheckoutUrl');
        setActiveOrderId(null);
        setChapaCheckoutUrl(null);
      }
    });

    // Clean up URL so it doesn't stay forever, but we already have the listener going!
    const params = new URLSearchParams(window.location.search);
    if (params.has('tx_ref')) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    return () => unsubscribeOrder();
  }, [activeOrderId]);

  const handleLogin = async () => {
    if (loginLoading) return;
    setLoginLoading(true);
    setLoginError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      console.error("Login failed", error);
      let message = error.message || String(error);
      if (error.code === 'auth/cancelled-popup-request') {
        message = "A previous sign-in popup is already open or was cancelled. Please wait a moment and try again.";
      } else if (error.code === 'auth/popup-closed-by-user') {
        message = "The sign-in popup was closed before completing. Please try again.";
      } else if (message.includes("Pending promise was never set")) {
        message = "Browser cookie/storage policy prevented communication. Opening the app in a new tab will resolve this.";
      }
      setLoginError(message);
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
      alert("Please log in to save your favorite dishes.");
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
      alert("Please sign in to make a reservation.");
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

      alert("Reservation requested successfully! We will confirm shortly.");
      setIsReservationOpen(false);
      setReservationForm({ date: "", time: "19:00", partySize: 2 });
    } catch (error) {
      console.error("Reservation failed:", error);
      alert("Failed to submit reservation. Please try again.");
    } finally {
      setIsSubmittingReservation(false);
    }
  };

  const addToCart = (item: MenuItem) => {
    setCart(prev => {
      const existing = prev.find(i => i.menuItem.id === item.id);
      if (existing) {
        return prev.map(i => i.menuItem.id === item.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { menuItem: item, quantity: 1 }];
    });
    // Removed automatic cart sidebar popup to wait until user clicks explicitly
  };

  const updateCartQuantity = (itemId: string, delta: number) => {
    setCart(prev => {
      return prev.map(i => {
        if (i.menuItem.id === itemId) {
          const nextQty = i.quantity + delta;
          return nextQty > 0 ? { ...i, quantity: nextQty } : i;
        }
        return i;
      }).filter(i => i.quantity > 0);
    });
  };

  const removeFromCart = (itemId: string) => {
    setCart(prev => prev.filter(i => i.menuItem.id !== itemId));
  };

  const cartTotal = cart.reduce((acc, item) => acc + (item.menuItem.price * item.quantity), 0);
  const taxAmount = cartTotal * (checkoutSettings.serviceTaxPercent / 100);

  let discountAmount = 0;
  if (appliedPromo) {
    if (appliedPromo.type === 'percentage') {
      discountAmount = cartTotal * (appliedPromo.value / 100);
      if (appliedPromo.maxDiscount) {
        discountAmount = Math.min(discountAmount, appliedPromo.maxDiscount);
      }
    } else {
      discountAmount = appliedPromo.value;
    }
  }

  let pointsDiscount = 0;
  let pointsUsed = 0;
  // 1 point = 1 ETB
  if (usePoints && userProfile?.points > 0) {
    pointsDiscount = Math.min(userProfile.points, (cartTotal + taxAmount + checkoutSettings.flatFeeETB - discountAmount));
    pointsUsed = pointsDiscount;
  }

  const finalTotal = Math.max(0, cartTotal + taxAmount + checkoutSettings.flatFeeETB - discountAmount - pointsDiscount);
  // Earn 1 point for every 100 ETB spent (on final total after discounts, before tax/fees preferably, but we'll just use finalTotal)
  const pointsEarned = Math.floor(finalTotal / 100);

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
    setCheckoutLoading(true);

    // Make delivery address strictly required
    if (!googleMapsAddress.trim()) {
      alert("Please provide a Delivery Address so our courier can locate you.");
      setCheckoutLoading(false);
      return;
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
      if (paymentMethod === 'chapa') {
        // Use Server-side initialization with Secret Key for better security and stability
        const res = await fetch("/api/chapa/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: finalTotal,
            email: customerEmail,
            first_name: firstName,
            last_name: lastName,
            phone_number: customerPhone,
            blockNumber,
            roomNumber,
            googleMapsAddress,
            specialInstructions,
            items: cart,
            userId: user?.uid,
            serviceTax: taxAmount,
            flatFee: checkoutSettings.flatFeeETB,
            promoCode: appliedPromo?.code,
            discountAmount,
            pointsUsed,
            pointsEarned
          })
        });

        const resText = await res.text();
        let data: any = {};
        try {
          data = resText ? JSON.parse(resText) : {};
        } catch (e) {
          console.error("Failed to parse JSON response from /api/chapa/initialize. Raw response:", resText);
          throw new Error(`Server response error (${res.status}): ${resText.slice(0, 150) || "Empty response from backend server."}`);
        }

        if (data.success) {
          if (data.simulated) {
            alert(`Payment initialization failed (falling back to sandbox which was removed). Please check your CHAPA_SECRET_KEY in the environment.\n\nError: ${data.warning}`);
            setCheckoutLoading(false);
          } else if (data.checkoutUrl) {
            if (data.txRef) {
              localStorage.setItem('activeOrderId', data.txRef);
              setActiveOrderId(data.txRef);
            }

            // Optimistically clear cart
            setCart([]);
            setIsCheckingOut(false);
            setIsCartOpen(false);
            setSpecialInstructions("");
            setBlockNumber("");
            setRoomNumber("");
            setGoogleMapsAddress("");

            // Redirect user to Chapa
            setCheckoutLoading(false);
            window.location.href = data.checkoutUrl;
          }
        } else {
          console.error("Chapa initialization failed details:", data);
          const errorMsg = typeof data.error === 'object' ? JSON.stringify(data.error) : (data.error || "Unknown error");
          alert("Failed to initialize Chapa payment: " + errorMsg);
          setCheckoutLoading(false);
        }
      } else {
        // Save order as pending in DB directly for Cash
        const res = await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: cart,
            total: finalTotal,
            customerName: customerName,
            customerEmail: customerEmail,
            customerPhone: customerPhone,
            blockNumber,
            roomNumber,
            googleMapsAddress,
            specialInstructions,
            paymentMethod: "cash",
            paymentStatus: "pending",
            status: "pending",
            userId: user?.uid,
            serviceTax: taxAmount,
            flatFee: checkoutSettings.flatFeeETB,
            promoCode: appliedPromo?.code,
            discountAmount,
            pointsUsed,
            pointsEarned
          })
        });
        const data = await res.json();

        if (data.success) {
          setPlacedOrder(data.order);
          setCart([]);
          setIsCheckingOut(false);
          setIsCartOpen(false);
          setCheckoutLoading(false);
          setSpecialInstructions("");
          setBlockNumber("");
          setRoomNumber("");
          setGoogleMapsAddress("");
        } else {
          alert("Failed to create cash order");
          setCheckoutLoading(false);
        }
      }
    } catch (err: any) {
      alert(`Checkout failed: ${err.message}`);
      setCheckoutLoading(false);
    }
  };

  // Filtered menu logic
  const filteredMenu = menu.filter(item => {
    const matchesCategory = selectedCategory === 'all' ||
      item.category === selectedCategory ||
      (item.categories && item.categories.includes(selectedCategory));
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.description.toLowerCase().includes(searchQuery.toLowerCase());
    const isCurrentlyActive = item.isActive !== false;
    return matchesCategory && matchesSearch && isCurrentlyActive;
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="animate-spin text-amber-600">
          <Utensils className="w-10 h-10" />
        </div>
      </div>
    );
  }

  if (!user && !isGuest) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center px-4 py-12">
        <div className="bg-white p-8 md:p-10 rounded-3xl shadow-xl max-w-md w-full text-center border border-stone-200">
          {globalSettings?.logoUrl ? (
            <img src={globalSettings.logoUrl} alt="Logo" className="mx-auto h-16 w-auto object-contain rounded-2xl mb-6 shadow-md shadow-amber-600/20" />
          ) : (
            <div className="bg-amber-600 text-white p-4 rounded-2xl mx-auto w-16 h-16 flex items-center justify-center mb-6 shadow-md shadow-amber-600/20">
              <Utensils className="w-8 h-8" />
            </div>
          )}
          <h1 className="font-serif text-3xl font-bold text-stone-900 mb-2">Welcome to {globalSettings?.restaurantName || "SAVORY"}</h1>
          <p className="text-stone-500 mb-6 text-sm">Sign in to sync your profile and rewards, or browse as a guest.</p>

          <div className="space-y-3">
            <button
              onClick={handleLogin}
              disabled={loginLoading}
              className="w-full flex items-center justify-center space-x-3 bg-stone-900 hover:bg-stone-800 text-white p-4 rounded-xl font-bold transition-all cursor-pointer disabled:opacity-50 shadow-md"
            >
              {loginLoading ? (
                <span className="animate-spin inline-block w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
              ) : (
                <User className="w-5 h-5" />
              )}
              <span>{loginLoading ? "Signing in..." : "Sign in with Google"}</span>
            </button>

            <button
              onClick={() => setIsGuest(true)}
              className="w-full flex items-center justify-center space-x-2 bg-stone-100 hover:bg-amber-600 hover:text-white text-stone-800 p-3.5 rounded-xl font-bold transition-all cursor-pointer border border-stone-300 text-sm"
            >
              <span>Browse Menu as Guest</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          {loginError && (
            <div className="mt-4 p-3.5 bg-red-50 border border-red-100 rounded-xl text-left text-xs text-red-700 leading-relaxed font-sans">
              <p className="font-semibold mb-1">Sign-In Failed</p>
              <p className="opacity-90">{loginError}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <APIProvider apiKey={API_KEY} version="weekly">
      <div id="main-applet" className="min-h-screen bg-stone-50 text-stone-900 font-sans flex flex-col antialiased selection:bg-amber-100 selection:text-amber-900">

        {/* Premium Elegant Header */}
        <header className="bg-white border-b border-stone-200 sticky top-0 z-40 backdrop-blur-md bg-white/95">
          <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
            {/* Logo / Brand */}
            <div className="flex items-center space-x-3 cursor-pointer">
              {globalSettings?.logoUrl ? (
                <img src={globalSettings.logoUrl} alt="Logo" className="h-10 w-auto object-contain rounded" />
              ) : (
                <div className="bg-amber-600 text-white p-2.5 rounded-2xl shadow-md shadow-amber-600/10 flex items-center justify-center">
                  <Utensils className="w-6 h-6" />
                </div>
              )}
              <div>
                <span className="font-serif text-xl font-bold tracking-tight text-stone-900 block leading-none">
                  {globalSettings?.restaurantName || "SAVORY"}
                </span>
                <span className="text-[10px] font-mono tracking-widest text-stone-500 uppercase">RESTAURANT</span>
              </div>
            </div>

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
                    <img
                      src={user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || 'User')}&background=random`}
                      alt="Profile"
                      className="w-8 h-8 rounded-full border border-stone-200"
                    />
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

              <button
                onClick={() => setIsCartOpen(true)}
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
        <main className="flex-grow max-w-7xl w-full mx-auto px-6 py-8">

          {!checkoutSettings.isOpen && (
            <div className="mb-8 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-2xl flex flex-col items-center justify-center text-center shadow-sm">
              <h2 className="font-serif font-bold text-lg mb-1 flex items-center space-x-2">
                <span>We're Currently Closed</span>
              </h2>
              <p className="text-xs text-rose-600 font-medium">
                We are not accepting orders at this time. Please check back later!
              </p>
            </div>
          )}

          {/* GOURMET MENU */}
          <div className="space-y-10">

            {/* Elegant Landing Hero */}
            <div className="bg-gradient-to-br from-stone-900 to-stone-950 rounded-3xl p-8 md:p-12 text-white relative overflow-hidden shadow-xl border border-stone-800">
              <div className="absolute top-0 right-0 w-96 h-96 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

              <div className="max-w-2xl relative z-10 space-y-4">

                <h1 className="font-serif text-3xl md:text-5xl font-bold tracking-tight text-white leading-tight">
                  Offering High Quality Experiences
                </h1>
                <p className="text-stone-300 text-sm md:text-base leading-relaxed">
                  Welcome to Savory
                </p>
                <div className="pt-2">
                  <button
                    onClick={() => {
                      const menuSection = document.getElementById("gourmet-menu-section");
                      menuSection?.scrollIntoView({ behavior: "smooth" });
                    }}
                    className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold tracking-wide uppercase px-6 py-3.5 rounded-xl transition-all cursor-pointer flex items-center space-x-2"
                  >
                    <span>Explore Gourmet Selection</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

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
                      className="w-full pl-10 pr-4 py-2 border border-stone-250 bg-white rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {[{ id: 'all', name: 'All Items' }, ...categories].map(cat => (
                      <button
                        key={cat.id}
                        onClick={() => setSelectedCategory(cat.id)}
                        className={`px-3 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all capitalize cursor-pointer ${selectedCategory === cat.id
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
              <div className="bg-[#FAF9F6] border-2 border-stone-200 shadow-xl max-w-4xl mx-auto p-6 md:p-16 relative">
                {/* Decorative border */}
                <div className="absolute inset-3 border border-stone-300 pointer-events-none"></div>

                <div className="text-center mb-10 relative z-10">
                  <h2 className="font-serif text-2xl md:text-3xl font-bold text-stone-900 tracking-widest uppercase">The Menu</h2>
                  <div className="w-16 h-px bg-stone-400 mx-auto mt-4"></div>
                </div>

                {filteredMenu.length === 0 ? (
                  <div className="text-center py-20 bg-transparent relative z-10">
                    <Utensils className="w-12 h-12 text-stone-300 mx-auto mb-3 stroke-1" />
                    <p className="text-stone-800 font-semibold text-sm">No dishes found matching your selection.</p>
                  </div>
                ) : (
                  <div className="space-y-8 relative z-10">
                    {filteredMenu.map(dish => (
                      <Link
                        key={dish.id}
                        to={`/food/${dish.id}`}
                        className="group flex flex-col sm:flex-row justify-between items-baseline cursor-pointer hover:bg-stone-100/50 p-3 -mx-3 rounded transition-colors"
                      >
                        <div className="flex-1 pr-4 w-full">
                          <div className="flex items-baseline w-full">
                            <h3 className="font-serif font-bold text-base md:text-lg text-stone-900 group-hover:text-amber-700 whitespace-nowrap">{dish.name}</h3>
                            <div className="flex-grow border-b-2 border-dotted border-stone-300 mx-3 opacity-50 relative top-[-6px]"></div>
                          </div>
                          <p className="text-xs md:text-sm text-stone-600 mt-1 font-serif italic line-clamp-2">{dish.description}</p>
                          <div className="flex space-x-2 mt-2 font-sans items-center">
                            {dish.popular && <span className="text-[10px] font-bold text-amber-700 uppercase tracking-widest">★ Popular</span>}
                            {dish.prepTime && <span className="text-[10px] text-stone-500 uppercase tracking-widest">{dish.popular ? '• ' : ''}{dish.prepTime}</span>}
                            {dish.menuTiming && dish.menuTiming !== "All Day" && (
                              <span className="text-[10px] text-emerald-700 uppercase tracking-widest">• {dish.menuTiming}</span>
                            )}
                          </div>
                        </div>
                        <div className="pl-0 sm:pl-4 mt-3 sm:mt-0 shrink-0 flex flex-row sm:flex-col items-center sm:items-end justify-between w-full sm:w-auto">
                          <span className="font-mono text-base md:text-lg font-bold text-stone-900 group-hover:text-amber-700 transition-colors">{dish.price.toFixed(2)} ETB</span>
                          <button
                            disabled={!checkoutSettings.isOpen}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              addToCart(dish);
                            }}
                            className={`mt-0 sm:mt-2 text-[10px] font-bold uppercase tracking-widest px-4 py-1.5 rounded transition-colors ${checkoutSettings.isOpen
                              ? 'bg-stone-200 text-stone-800 hover:bg-amber-600 hover:text-white'
                              : 'bg-stone-200 text-stone-400 cursor-not-allowed'
                              }`}
                          >
                            {checkoutSettings.isOpen ? 'Add' : 'Closed'}
                          </button>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Cart lateral Drawer Overlay */}
        {isCartOpen && (
          <div id="cart-drawer-overlay" className="fixed inset-0 bg-black/45 z-50 flex justify-end backdrop-blur-xs">
            <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col justify-between animate-slide-left font-sans">
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
                      <div key={item.menuItem.id} className="flex justify-between items-center pb-4 border-b border-stone-100 animate-fade-in">
                        <div className="flex items-center space-x-3 truncate">
                          <img src={item.menuItem.image} alt={item.menuItem.name} className="w-12 h-12 rounded-lg object-cover bg-stone-100 border border-stone-200 flex-shrink-0" />
                          <div className="truncate">
                            <h4 className="font-serif font-bold text-stone-950 text-sm leading-tight">{item.menuItem.name}</h4>
                            <span className="text-xs text-amber-700 font-semibold font-mono block mt-1">{item.menuItem.price.toFixed(2)} ETB</span>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2.5">
                          <div className="flex items-center border border-stone-200 rounded-lg bg-stone-50">
                            <button onClick={() => updateCartQuantity(item.menuItem.id, -1)} className="px-2 py-1 text-stone-500 hover:text-stone-900 font-bold cursor-pointer">-</button>
                            <span className="px-2 text-xs font-bold font-mono text-stone-800">{item.quantity}</span>
                            <button onClick={() => updateCartQuantity(item.menuItem.id, 1)} className="px-2 py-1 text-stone-500 hover:text-stone-900 font-bold cursor-pointer">+</button>
                          </div>
                          <button onClick={() => removeFromCart(item.menuItem.id)} className="text-stone-400 hover:text-rose-600 p-1 cursor-pointer">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    /* Checkout Form */
                    <form onSubmit={handleCheckout} className="space-y-4 animate-fade-in">
                      <div className="pb-2 border-b border-stone-150">
                        <h4 className="font-serif font-bold text-sm text-stone-900">Delivery & Checkout Information</h4>
                        <p className="text-[11px] text-stone-500 mt-0.5">Please provide your details below to finalize your secure transaction.</p>
                      </div>

                      <div className="space-y-3">
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
                            className="w-full text-xs border border-stone-350 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
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
                            placeholder="name@example.com"
                            className="w-full text-xs border border-stone-350 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Mobile Contact Phone *</label>
                          <input
                            type="tel"
                            name="tel"
                            autoComplete="tel"
                            required
                            value={customerPhone}
                            onChange={e => setCustomerPhone(e.target.value)}
                            placeholder="+251911223344"
                            className="w-full text-xs border border-stone-355 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                          />
                        </div>

                        <div className="bg-amber-50 border border-amber-200/60 rounded-xl p-3 text-[11px] text-amber-800 leading-relaxed space-y-0.5">
                          <span className="font-bold block text-[12px] text-amber-900">📍 Exact Address Required *</span>
                          Please provide your <strong className="text-amber-950">Delivery Address</strong>. Block and Room numbers are secondary.
                        </div>

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
                              className="w-full text-xs border border-stone-355 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
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
                              className="w-full text-xs border border-stone-355 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
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
                              className="w-full text-xs border border-stone-355 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                            />
                          )}
                        </div>

                        <div>
                          <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">Special Instructions (Optional)</label>
                          <textarea
                            value={specialInstructions}
                            onChange={e => setSpecialInstructions(e.target.value)}
                            placeholder="Allergies, door code, extra napkins..."
                            rows={2}
                            className="w-full text-xs border border-stone-355 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
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
                                <span className="text-[10px]">Chapa Pay</span>
                              </div>
                              <span className="text-[8px] opacity-75">Telebirr / CBE / Cards</span>
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
                              <ClipboardList className={`w-4 h-4 ${checkoutSettings.enableCOD ? 'text-stone-700' : 'text-stone-300'}`} />
                              <span className="text-[10px]">Cash on Delivery</span>
                              {!checkoutSettings.enableCOD && <span className="text-[7px] uppercase font-bold text-rose-500">Disabled</span>}
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
                <div className="p-6 border-t border-stone-150 bg-stone-50">

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
                            className="flex-1 text-xs border border-stone-355 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-white"
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

                      {userProfile?.points > 0 && (
                        <div className="flex items-center justify-between bg-white p-3 rounded-xl border border-stone-200 shadow-sm">
                          <div className="flex items-center space-x-2">
                            <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                            <div>
                              <p className="text-xs font-bold text-stone-900">Use Loyalty Points</p>
                              <p className="text-[10px] text-stone-500">You have {userProfile.points} points ({userProfile.points} ETB)</p>
                            </div>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" className="sr-only peer" checked={usePoints} onChange={() => setUsePoints(!usePoints)} />
                            <div className="w-9 h-5 bg-stone-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-600"></div>
                          </label>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-1.5 mb-4 text-xs text-stone-600">
                    <div className="flex justify-between">
                      <span>Subtotal</span>
                      <span className="font-mono">{cartTotal.toFixed(2)} ETB</span>
                    </div>
                    {checkoutSettings.serviceTaxPercent > 0 && (
                      <div className="flex justify-between">
                        <span>Service Tax ({checkoutSettings.serviceTaxPercent}%)</span>
                        <span className="font-mono">+{taxAmount.toFixed(2)} ETB</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span>Delivery Fee</span>
                      {checkoutSettings.flatFeeETB > 0 ? (
                        <span className="font-mono">+{checkoutSettings.flatFeeETB.toFixed(2)} ETB</span>
                      ) : (
                        <span className="text-emerald-700 font-bold">FREE</span>
                      )}
                    </div>
                    {appliedPromo && (
                      <div className="flex justify-between text-emerald-700 font-semibold">
                        <span>Promo ({appliedPromo.code})</span>
                        <span className="font-mono">-{discountAmount.toFixed(2)} ETB</span>
                      </div>
                    )}
                    {usePoints && pointsUsed > 0 && (
                      <div className="flex justify-between text-amber-600 font-semibold">
                        <span>Points Used</span>
                        <span className="font-mono">-{pointsUsed.toFixed(2)} ETB</span>
                      </div>
                    )}
                    <div className="flex justify-between text-stone-900 font-bold text-sm pt-2 border-t border-stone-200">
                      <span>Total Bill:</span>
                      <span className="font-mono text-amber-700">{finalTotal.toFixed(2)} ETB</span>
                    </div>
                    {isCheckingOut && finalTotal > 0 && (
                      <div className="text-right mt-1">
                        <span className="text-[10px] text-stone-500 font-semibold">
                          Earns <strong className="text-amber-600">{pointsEarned}</strong> points
                        </span>
                      </div>
                    )}
                  </div>

                  {!isCheckingOut ? (
                    <button
                      disabled={!checkoutSettings.isOpen}
                      onClick={() => {
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
                      className={`w-full font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-all flex items-center justify-center ${checkoutSettings.isOpen ? 'bg-stone-900 hover:bg-amber-600 text-white cursor-pointer' : 'bg-stone-300 text-stone-500 cursor-not-allowed'
                        }`}
                    >
                      <span>{checkoutSettings.isOpen ? 'Proceed to Delivery details' : 'Currently Closed'}</span>
                      {checkoutSettings.isOpen && <ChevronRight className="w-4 h-4 ml-1" />}
                    </button>
                  ) : (
                    <div className="flex space-x-2">
                      <button
                        onClick={() => {
                          const trigger = document.getElementById("hidden-submit-trigger");
                          trigger?.click();
                        }}
                        disabled={checkoutLoading}
                        className={`flex-1 font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-all flex items-center justify-center cursor-pointer disabled:opacity-50 ${paymentMethod === 'chapa'
                          ? 'bg-[#071224] hover:bg-[#0c1e3a] text-white space-x-1.5'
                          : 'bg-amber-600 hover:bg-amber-700 text-white'
                          }`}
                      >
                        {checkoutLoading ? 'Processing...' : (
                          paymentMethod === 'chapa' ? (
                            <span className="flex items-center space-x-2 justify-center">
                              <div className="bg-white p-0.5 rounded-md flex items-center justify-center shadow-2xs">
                                <ChapaLogoSVG className="w-4.5 h-4.5 flex-shrink-0" />
                              </div>
                              <span>Pay with Chapa</span>
                            </span>
                          ) : 'Confirm Order'
                        )}
                      </button>
                      <button
                        onClick={() => setIsCheckingOut(false)}
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
          <div id="receipt-modal" className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
            <div className="bg-amber-50/5 text-stone-900 rounded-2xl max-w-md w-full relative flex flex-col shadow-2xl border border-stone-200 overflow-hidden animate-scale-up max-h-[90vh]">
              {/* Paper receipt design */}
              <div className="bg-[#FAF9F6] p-6 flex-grow overflow-y-auto font-mono text-xs text-stone-800 space-y-6 select-none relative">
                {/* Paper perforation top style */}
                <div className="absolute top-0 left-0 right-0 h-1.5 bg-[linear-gradient(45deg,transparent_33.333%,#FAF9F6_33.333%,#FAF9F6_66.667%,transparent_66.667%),linear-gradient(-45deg,transparent_33.333%,#FAF9F6_33.333%,#FAF9F6_66.667%,transparent_66.667%)] bg-[size:10px_10px] -mt-1"></div>

                {/* Receipt Header */}
                <div className="text-center space-y-2 mt-2">
                  <h2 className="text-lg font-serif font-black tracking-tight text-stone-950 uppercase">Savory Restaurant</h2>
                  <p className="text-[10px] text-stone-500 font-sans">100 Gourmet Way, Addis Ababa, Ethiopia</p>
                  <p className="text-[10px] text-stone-500 font-sans">Tel: +251 911 234567</p>
                  <div className="border-b border-dashed border-stone-300 my-4" />
                  <h3 className="text-[11px] font-bold text-stone-950 tracking-wider">OFFICIAL TRANSACTION RECEIPT</h3>
                  <p className="text-[10px] text-stone-400">STATUS: SECURELY PAID</p>
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
                    <span className="text-stone-500">Chapa ID:</span>
                    <span className="font-mono text-stone-900 text-right max-w-[180px] truncate">{selectedReceiptOrder.receipt?.transactionId || `chapa-sim-${selectedReceiptOrder.id}`}</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-stone-500">Method:</span>
                    <span className="font-semibold text-emerald-800 font-sans uppercase">{selectedReceiptOrder.receipt?.paymentMethod || "Chapa (CBE/Telebirr)"}</span>
                  </div>
                  {selectedReceiptOrder.paymentMethod === "chapa" && (
                    <div className="flex justify-between items-center text-[11px] pt-1.5 mt-1.5 border-t border-stone-200/40">
                      <span className="text-stone-500 font-medium">Chapa Receipt:</span>
                      <a
                        href={`https://chapa.link/payment-receipt/${selectedReceiptOrder.receipt?.reference || selectedReceiptOrder.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-bold text-emerald-700 hover:text-emerald-800 underline flex items-center gap-0.5 cursor-pointer"
                      >
                        View Receipt ↗
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
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&color=1c1917&data=${encodeURIComponent(
                          JSON.stringify({
                            orderId: selectedReceiptOrder.id,
                            name: selectedReceiptOrder.customerName,
                            total: `${selectedReceiptOrder.total.toFixed(2)} ETB`,
                            date: selectedReceiptOrder.receipt?.date || selectedReceiptOrder.createdAt,
                            payment: selectedReceiptOrder.receipt?.paymentMethod || "Chapa"
                          })
                        )}`}
                        alt="Order QR Code"
                        className="w-28 h-28"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                    <span className="text-[9px] font-mono text-stone-400 tracking-widest uppercase">Scan to Verify: {selectedReceiptOrder.id}</span>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[11px] font-serif font-bold italic text-stone-950">Thank you for ordering!</p>
                    <p className="text-[10px] text-stone-400">Enjoy your gourmet meal.</p>
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

        {/* Success Modal overlay */}
        {placedOrder && (
          <div id="order-success-modal" className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
            <div className="bg-white rounded-3xl max-w-md w-full p-6 text-center shadow-2xl border border-stone-100 animate-scale-up space-y-5 font-sans">
              <div className="w-14 h-14 bg-emerald-50 rounded-full flex items-center justify-center mx-auto text-emerald-500">
                <CheckCircle className="w-8 h-8" />
              </div>

              <div className="space-y-1">
                <h3 className="font-serif text-xl font-bold text-stone-950">Order Confirmed!</h3>
                <p className="text-xs text-stone-500">Your transaction has been securely recorded and is now processing.</p>
              </div>

              {/* Receipt Summary */}
              <div className="bg-stone-50 border border-stone-150 p-4 rounded-xl text-xs space-y-1.5 text-left text-stone-600">
                <div className="flex justify-between">
                  <span>Order Reference:</span>
                  <strong className="text-stone-950 font-mono text-[11px]">{placedOrder.id}</strong>
                </div>
                <div className="flex justify-between">
                  <span>Customer:</span>
                  <strong className="text-stone-950">{placedOrder.customerName}</strong>
                </div>
                <div className="flex justify-between">
                  <span>Payment Method:</span>
                  <strong className="text-stone-950 uppercase">{placedOrder.paymentMethod}</strong>
                </div>
                <div className="flex justify-between items-center">
                  <span>Payment Status:</span>
                  <div className="flex items-center space-x-2">
                    {placedOrder.paymentStatus === "completed" ? (
                      <button
                        onClick={() => setSelectedReceiptOrder(placedOrder)}
                        className="bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-lg text-[10px] uppercase font-extrabold flex items-center space-x-1 cursor-pointer transition-all shadow-xs"
                        title="View Chapa transaction receipt"
                      >
                        <span>PAID</span>
                        <span className="text-[9px] underline opacity-80 font-medium">Receipt 📄</span>
                      </button>
                    ) : (
                      <strong className="text-amber-600 uppercase font-bold flex items-center">
                        <span className="flex items-center space-x-1.5">
                          <span>{placedOrder.paymentStatus || "PENDING"}</span>
                          <span className="flex space-x-1 items-center inline-flex h-3">
                            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                          </span>
                        </span>
                      </strong>
                    )}
                    {placedOrder.paymentStatus !== "completed" && (
                      <button
                        disabled={isVerifying}
                        onClick={async () => {
                          setIsVerifying(true);
                          try {
                            const res = await fetch(`/api/chapa/verify/${placedOrder.id}`);
                            const data = await res.json();
                            if (data.success && data.status === "completed") {
                              console.log("[CHAPA MANUAL VERIFY] Success!");
                            } else {
                              alert("Status is still processing on Chapa's side. If you have already completed the payment, it will update shortly. Current state: " + (data.status || "pending"));
                            }
                          } catch (e) {
                            console.error("[CHAPA MANUAL VERIFY] Error:", e);
                            alert("Failed to connect to the verification server. Please try again.");
                          } finally {
                            setIsVerifying(false);
                          }
                        }}
                        className="p-1 rounded bg-stone-100 hover:bg-stone-200 text-stone-600 hover:text-stone-800 transition flex items-center justify-center min-w-[24px]"
                        title="Refresh status"
                      >
                        {isVerifying ? (
                          <span className="flex space-x-0.5 items-center inline-flex h-3 px-0.5">
                            <span className="w-1 h-1 bg-amber-600 rounded-full animate-ping" style={{ animationDelay: '0ms' }} />
                            <span className="w-1 h-1 bg-amber-600 rounded-full animate-ping" style={{ animationDelay: '100ms' }} />
                            <span className="w-1 h-1 bg-amber-600 rounded-full animate-ping" style={{ animationDelay: '200ms' }} />
                          </span>
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
                <div className="border-t border-stone-200 mt-2.5 pt-2 flex justify-between font-bold text-stone-950">
                  <span>Amount Paid:</span>
                  <span className="font-mono text-amber-700">{placedOrder.total.toFixed(2)} ETB</span>
                </div>
              </div>

              {placedOrder.paymentStatus !== "completed" && (
                <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl text-center space-y-4 shadow-sm">
                  <div>
                    <h4 className="text-sm font-bold text-amber-800 flex items-center justify-center space-x-1">
                      <span>ℹ️ Waiting for payment</span>
                    </h4>
                    <p className="text-xs text-amber-700 leading-relaxed mt-1">
                      To complete your order, please process the payment via Chapa in a new tab. Once done, come back here and click the refresh button above.
                    </p>
                  </div>
                  {placedOrder.chapaCheckoutUrl && (
                    <div>
                      <a
                        href={placedOrder.chapaCheckoutUrl}
                        className="inline-block bg-[#00A859] hover:bg-[#008f4c] text-white font-bold py-3 px-6 rounded-xl text-xs uppercase tracking-wider transition-colors shadow-md cursor-pointer"
                      >
                        Pay Now via Chapa
                      </a>
                    </div>
                  )}
                </div>
              )}

              <div className="text-center">
                <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 py-1.5 px-3 rounded-lg inline-block">
                  🍜 {
                    placedOrder.status === "delivered" ? "Your order is ready / delivered!" :
                      placedOrder.status === "preparing" ? "The kitchen is now preparing your delicious meal!" :
                        placedOrder.paymentStatus === "completed" ? "Payment received! The kitchen will review and start cooking soon." :
                          "Your order is securely registered!"
                  }
                </p>
              </div>

              {placedOrder.shipdayTrackingLink && (
                <div className="bg-blue-50 border border-blue-100 p-4 rounded-2xl flex flex-col items-center animate-fade-in">
                  <Truck className="w-8 h-8 text-blue-600 mb-2" />
                  <h4 className="text-sm font-bold text-blue-900">Track Your Delivery</h4>
                  <p className="text-[11px] text-blue-600 mb-3 text-center">Your order has been dispatched! Track your driver in real-time below.</p>
                  <a
                    href={placedOrder.shipdayTrackingLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider text-center transition-colors"
                  >
                    Open Live Tracker
                  </a>
                </div>
              )}

              <div className="flex space-x-2">
                <button
                  onClick={() => {
                    setPlacedOrder(null);
                    localStorage.removeItem('activeOrderId');
                    setActiveOrderId(null);
                  }}
                  className="flex-grow bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl text-xs uppercase tracking-wider cursor-pointer transition-colors"
                >
                  Continue Browsing
                </button>
                {placedOrder.paymentStatus !== "completed" && (
                  <button
                    onClick={async () => {
                      if (window.confirm("Are you sure you want to cancel this order?")) {
                        try {
                          const { deleteDoc, doc } = await import("firebase/firestore");
                          await deleteDoc(doc(db, "orders", placedOrder.id));
                          setPlacedOrder(null);
                          localStorage.removeItem('activeOrderId');
                          localStorage.removeItem('chapaCheckoutUrl');
                          setActiveOrderId(null);
                          setChapaCheckoutUrl(null);
                        } catch (err) {
                          alert("Failed to cancel order.");
                        }
                      }
                    }}
                    className="bg-stone-200 hover:bg-stone-300 text-stone-700 font-bold px-4 py-3 rounded-xl text-xs uppercase tracking-wider cursor-pointer transition-colors"
                  >
                    Cancel Order
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* My Orders Modal overlay */}
        {isMyOrdersOpen && (
          <div id="my-orders-modal" className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
            <div className="bg-white rounded-3xl max-w-lg w-full max-h-[80vh] flex flex-col shadow-2xl border border-stone-100 animate-scale-up font-sans">
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
                {myOrders.length === 0 ? (
                  <div className="text-center py-10 text-stone-400">
                    <ClipboardList className="w-12 h-12 mx-auto mb-3 stroke-1 text-stone-300" />
                    <p className="text-sm font-medium">You haven't placed any orders yet.</p>
                  </div>
                ) : (
                  Object.entries(groupOrdersByDate(myOrders)).map(([dateGroup, groupOrders]) => (
                    <div key={dateGroup} className="space-y-3">
                      <div className="sticky top-0 z-10 bg-stone-100/95 backdrop-blur-md py-1.5 px-3 rounded-lg text-[10px] font-bold text-stone-600 tracking-wider uppercase flex justify-between items-center border border-stone-200/50 shadow-xs">
                        <span>{dateGroup}</span>
                        <span className="bg-stone-250 text-stone-700 px-2 py-0.5 rounded-full font-mono text-[9px]">
                          {groupOrders.length} {groupOrders.length === 1 ? 'order' : 'orders'}
                        </span>
                      </div>
                      <div className="space-y-3">
                        {groupOrders.map(order => {
                          const isPendingAndUnpaid = order.paymentStatus !== 'completed' && order.status === 'pending';
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
                                : 'bg-stone-50 border-stone-150 cursor-pointer'
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
                                    {order.status}
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
                                      : order.paymentStatus === 'failed'
                                        ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                                      }`}
                                    title={order.paymentStatus === 'completed' ? "Click to view receipt" : undefined}
                                  >
                                    {order.paymentStatus === 'completed' ? (
                                      <>
                                        <span>PAID ✅</span>
                                        <span className="underline opacity-80 text-[8px] font-medium ml-0.5">Receipt</span>
                                      </>
                                    ) : (
                                      order.paymentStatus || 'PENDING'
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
                                    href={order.shipdayTrackingLink}
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
          <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4 backdrop-blur-md">
            <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-stone-150 animate-scale-up font-sans text-center space-y-4">
              <div className="mx-auto w-12 h-12 bg-amber-50 rounded-full flex items-center justify-center text-amber-600">
                <ClipboardList className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-serif text-lg font-bold text-stone-900">Manage Order</h3>
                <p className="font-mono text-xs text-stone-500 mt-1">Order ID: {orderActionModal.id}</p>
                <p className="text-xs text-stone-600 mt-2 leading-relaxed">
                  This order is waiting for payment. Would you like to pay now via Chapa or cancel this order?
                </p>
              </div>

              <div className="space-y-2.5 pt-2">
                <button
                  onClick={() => {
                    setActiveOrderId(orderActionModal.id);
                    localStorage.setItem('activeOrderId', orderActionModal.id);
                    setIsMyOrdersOpen(false);
                    const chapaUrl = orderActionModal.chapaCheckoutUrl;
                    setOrderActionModal(null);
                    if (chapaUrl) {
                      window.location.href = chapaUrl;
                    }
                  }}
                  className="w-full bg-[#00A859] hover:bg-[#008f4c] text-white font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-colors shadow-md cursor-pointer flex items-center justify-center space-x-2.5"
                >
                  <div className="bg-white p-0.5 rounded-md flex items-center justify-center shadow-2xs">
                    <ChapaLogoSVG className="w-4 h-4 flex-shrink-0" />
                  </div>
                  <span>Pay Now via Chapa</span>
                </button>

                <button
                  onClick={async () => {
                    if (window.confirm("Are you sure you want to cancel this order?")) {
                      try {
                        const { deleteDoc, doc } = await import("firebase/firestore");
                        await deleteDoc(doc(db, "orders", orderActionModal.id));
                        if (activeOrderId === orderActionModal.id) {
                          setPlacedOrder(null);
                          localStorage.removeItem('activeOrderId');
                          setActiveOrderId(null);
                        }
                        setOrderActionModal(null);
                      } catch (err) {
                        alert("Failed to cancel order.");
                      }
                    }
                  }}
                  className="w-full bg-rose-50 hover:bg-rose-100 text-rose-750 font-bold py-3 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                >
                  Cancel Order
                </button>

                <button
                  onClick={() => setOrderActionModal(null)}
                  className="w-full bg-stone-100 hover:bg-stone-200 text-stone-700 font-medium py-3 rounded-xl text-xs uppercase tracking-wider transition-colors cursor-pointer"
                >
                  Keep Order (Close)
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
                const allImages = [expandedProduct.image, ...(expandedProduct.galleryImages || [])];
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
                    <span className="bg-stone-100 text-stone-600 text-[10px] font-bold px-2 py-0.5 rounded-md font-mono tracking-wide uppercase shadow-sm border border-stone-200">
                      <Clock className="w-3 h-3 inline mr-1 text-amber-600" />
                      {expandedProduct.prepTime || '15 mins'}
                    </span>
                  </div>

                  <div className="flex justify-between items-start gap-4">
                    <h2 className="font-serif text-2xl md:text-3xl font-bold text-stone-900 leading-tight">
                      {expandedProduct.name}
                    </h2>
                    <div className="text-right shrink-0">
                      <span className="font-mono text-xl font-bold text-amber-700 block">{expandedProduct.price.toFixed(2)} ETB</span>
                    </div>
                  </div>

                  <p className="mt-4 text-stone-600 leading-relaxed text-sm md:text-base">
                    {expandedProduct.description}
                  </p>
                </div>

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
                      onClick={() => setExpandedQuantity(Math.max(1, expandedQuantity - 1))}
                      className="w-10 h-10 flex items-center justify-center text-stone-500 hover:text-stone-900 hover:bg-stone-200 rounded-lg transition-colors font-mono text-lg"
                    >
                      -
                    </button>
                    <span className="font-mono font-bold text-stone-900 w-4 text-center">{expandedQuantity}</span>
                    <button
                      onClick={() => setExpandedQuantity(expandedQuantity + 1)}
                      className="w-10 h-10 flex items-center justify-center text-stone-500 hover:text-stone-900 hover:bg-stone-200 rounded-lg transition-colors font-mono text-lg"
                    >
                      +
                    </button>
                  </div>

                  <button
                    disabled={!checkoutSettings.isOpen}
                    onClick={() => {
                      addToCart(expandedProduct);
                      if (expandedQuantity > 1) {
                        for (let i = 1; i < expandedQuantity; i++) {
                          addToCart(expandedProduct);
                        }
                      }
                      handleCloseProductModal();
                    }}
                    className={`flex-grow font-bold py-3.5 px-6 rounded-xl transition-colors w-full flex justify-between items-center text-sm tracking-wide shadow-md ${checkoutSettings.isOpen ? 'bg-stone-900 hover:bg-amber-600 text-white cursor-pointer' : 'bg-stone-300 text-stone-500 cursor-not-allowed'
                      }`}
                  >
                    <span className="uppercase">{checkoutSettings.isOpen ? 'Add to Order' : 'Closed'}</span>
                    {checkoutSettings.isOpen && <span className="font-mono bg-white/20 px-2 py-1 rounded">{(expandedProduct.price * expandedQuantity).toFixed(2)} ETB</span>}
                  </button>
                </div>

                {/* Reviews Section */}
                <div className="mt-8">
                  <ItemReviews menuItemId={expandedProduct.id} user={user} />
                </div>
              </div>
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
              <p className="text-xs leading-relaxed">
                {/* contact us info */}
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-widest text-white">Location</h4>
              <p className="text-xs leading-relaxed font-sans">
                {/*add location info */}
              </p>
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
            © {new Date().getFullYear()} {globalSettings?.restaurantName || "Savory"} • All rights reserved.
          </div>
        </footer>
        {globalSettings?.enableChatbot !== false && <Chatbot />}

        {/* Reservation Drawer Overlay */}
        {isReservationOpen && (
          <div className="fixed inset-0 bg-black/45 z-50 flex justify-center items-center backdrop-blur-xs p-4">
            <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden animate-scale-up font-sans">
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
  return (
    <Routes>
      <Route path="/admin/*" element={<AdminPortal />} />
      <Route path="*" element={<MainApp />} />
    </Routes>
  );
}
