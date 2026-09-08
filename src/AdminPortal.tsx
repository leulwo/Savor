import * as React from "react";
import { useState, useEffect, ReactNode } from "react";
import { MenuItem, Order, UserProfile } from "./types";
import MenuManager from "./components/MenuManager";
import OrderList from "./components/OrderList";
import CategoryManager from "./components/CategoryManager";
import GlobalSettingsPanel from "./components/GlobalSettingsPanel";
import AnalyticsDashboard from "./components/AnalyticsDashboard";
import OverviewDashboard from "./components/OverviewDashboard";
import AdminChat from "./components/AdminChat";
import ReservationManager from "./components/ReservationManager";
import KitchenDisplaySystem from "./components/KitchenDisplaySystem";
import PromoManager from "./components/PromoManager";
import TeamAndRoles from "./components/TeamAndRoles";
import CustomerManager from "./components/CustomerManager";
import ReportsManager from "./components/ReportsManager";
import CommandPalette from "./components/CommandPalette";
import { Utensils, Settings, LogOut, LayoutDashboard, MessageSquare, CalendarDays, ChefHat, ShoppingBag, Percent, Users, FileText, Search, BarChart3 } from "lucide-react";
import { db, auth, authedFetch, googleProvider } from "./firebase";
import { collection, query, where, orderBy, onSnapshot, doc, getDoc } from "firebase/firestore";
import { PermissionMap, hasPermission, getDefaultRole, seedDefaultRoles } from "./permissions";
import { onAuthStateChanged, signOut, signInWithPopup } from "firebase/auth";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  declare props: ErrorBoundaryProps;
  declare state: ErrorBoundaryState;
  declare setState: any;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error("AdminPortal ErrorBoundary caught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 bg-amber-50 border border-amber-200 rounded-xl text-stone-800 my-4 max-w-2xl mx-auto font-sans shadow-sm">
          <h3 className="text-lg font-serif font-bold text-amber-900 mb-2 flex items-center gap-2">
            ⚠️ {this.props.fallbackTitle || "Section Error"}
          </h3>
          <p className="text-xs font-mono bg-amber-100/60 p-3 rounded mb-4 overflow-x-auto text-amber-950">
            {this.state.error?.message || "An error occurred while loading this view."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="bg-stone-900 text-white text-xs font-bold px-4 py-2 rounded-lg hover:bg-stone-800 transition-colors cursor-pointer"
          >
            Reload Section
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AdminPortal() {
  // Distinguish a network/offline failure (keep the session, retry) from a
  // definitive authorization denial (sign out).
  const isLikelyOfflineError = (err: any) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
    const code = String(err?.code || "");
    const msg = String(err?.message || "").toLowerCase();
    return code === "offline" || code === "unavailable"
      || msg.includes("offline") || msg.includes("no network") || msg.includes("network connection");
  };

  const [isAdminAuthLoading, setIsAdminAuthLoading] = useState(true);
  const [adminUser, setAdminUser] = useState<any>(null);
  const [adminRole, setAdminRole] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionMap>({});
  const [loginError, setLoginError] = useState("");
  const [offlineNotice, setOfflineNotice] = useState("");
  const [retryTick, setRetryTick] = useState(0);

  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<UserProfile[]>([]);
  const [activeTab, setActiveTab] = useState<'overview' | 'analytics' | 'menu' | 'orders' | 'chat' | 'reservations' | 'kds' | 'marketing' | 'settings' | 'customers' | 'reports'>('overview');
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'checkout' | 'features' | 'dev' | 'privacy' | undefined>(undefined);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [totalUnread, setTotalUnread] = useState(0);

  const can = (key: string) => hasPermission(permissions, key);
  const actor = { email: adminUser?.email || 'system', role: adminRole || 'admin' };
  const [lastSeenTimestamp, setLastSeenTimestamp] = useState<number>(() => {
    const saved = localStorage.getItem("admin_last_seen_chat_time");
    return saved ? parseInt(saved) : Date.now();
  });

  useEffect(() => {
    if (activeTab === 'chat') {
      const now = Date.now();
      setLastSeenTimestamp(now);
      localStorage.setItem("admin_last_seen_chat_time", now.toString());
      setTotalUnread(0);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!can('chat.view')) return;
    // Listen for total messages in the last 24h
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const q = query(
      collection(db, "chat_messages"),
      where("createdAt", ">=", twentyFourHoursAgo),
      orderBy("createdAt", "desc")
    );

    const handleSnapshot = (snapshot: any) => {
      if (activeTab === 'chat') {
        setTotalUnread(0);
        return;
      }

      const messages = snapshot.docs.map((doc: any) => doc.data());
      const unread = messages.filter((m: any) => {
        if (m.role !== 'user') return false;
        const time = m.createdAt?.toMillis ? m.createdAt.toMillis() : 0;
        return time > lastSeenTimestamp;
      }).length;

      setTotalUnread(unread);
    };

    const unsubscribe = onSnapshot(q, handleSnapshot, (err) => {
      console.warn("Chat unread query error, falling back to simple collection listener:", err);
      onSnapshot(collection(db, "chat_messages"), handleSnapshot, () => { });
    });

    return () => unsubscribe();
  }, [activeTab, lastSeenTimestamp, permissions]);

  useEffect(() => {
    const handleOnline = () => setRetryTick(t => t + 1);
    window.addEventListener("online", handleOnline);

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Only allow Google sign-in (Google verifies emails on the provider
        // side, so every user here satisfies the hardened emailVerified rule).
        const isGoogle = user.providerData.some(p => p.providerId === "google.com");
        if (!isGoogle) {
          setLoginError("Access denied. Use the 'Continue with Google' button to access the Admin Portal.");
          await signOut(auth);
          setAdminUser(null);
          setIsAdminAuthLoading(false);
          return;
        }

        try {
          const emailLower = user.email ? user.email.toLowerCase() : "";
          if (!emailLower) {
            setLoginError("Account has no email address.");
            await signOut(auth);
            setAdminUser(null);
            setIsAdminAuthLoading(false);
            return;
          }

          const adminDocRef = doc(db, "admins", emailLower);
          const adminDocSnap = await getDoc(adminDocRef);
          const adminIsAuthorized = adminDocSnap.exists();
          const adminReadFromCache = adminDocSnap.metadata.fromCache;

          const loadRolePermissions = async (role: string): Promise<PermissionMap> => {
            try {
              const roleDocRef = doc(db, "roles", role);
              const roleDocSnap = await getDoc(roleDocRef);
              if (roleDocSnap.exists()) {
                const data = roleDocSnap.data() as any;
                if (data?.permissions && typeof data.permissions === 'object') {
                  return data.permissions as PermissionMap;
                }
              }
            } catch (err) {
              console.warn("Failed to load role doc, using defaults:", err);
            }
            const fallback = getDefaultRole(role);
            return fallback ? fallback.permissions : {};
          };

          if (adminIsAuthorized) {
            const role = String(adminDocSnap.data()?.role || "");
            let roleIsValid = !!role && !!getDefaultRole(role);
            try {
              await seedDefaultRoles(db);
              const roleDocSnap = await getDoc(doc(db, "roles", role));
              if (roleDocSnap.exists() || !!getDefaultRole(role)) {
                roleIsValid = true;
              }
            } catch (err) {
              console.warn("Failed to load role doc, falling back to defaults:", err);
              roleIsValid = !!role && !!getDefaultRole(role);
            }
            if (roleIsValid) {
              setOfflineNotice("");
              setLoginError("");
              setAdminUser(user);
              setAdminRole(role);
              const perms = await loadRolePermissions(role);
              setPermissions(perms);
              const can = (key: string) => hasPermission(perms, key);
              if (role === "admin") {
                setActiveTab("overview");
              } else if (role === "kitchen" && can("kds.view")) {
                setActiveTab("kds");
              } else if (can("orders.view")) {
                setActiveTab("orders");
              } else if (can("kds.view")) {
                setActiveTab("kds");
              } else if (can("menu.view")) {
                setActiveTab("menu");
              } else {
                setActiveTab("overview");
              }
            } else {
              setLoginError(`Access Denied: The account ${emailLower} does not have authorized access.`);
              await signOut(auth);
              setAdminUser(null);
              setAdminRole(null);
            }
          } else if (adminReadFromCache) {
            // Offline read with no cached admin record: authorization can't be
            // confirmed yet, so KEEP the session and retry when connectivity returns.
            setOfflineNotice("You appear to be offline. Your session is kept — retrying automatically when you're back online.");
            setAdminUser(null);
            setLoginError("");
          } else {
            setLoginError(`Access Denied: The account ${emailLower} is not authorized.`);
            await signOut(auth);
            setAdminUser(null);
            setAdminRole(null);
          }
        } catch (err: any) {
          console.error("Error verifying admin role:", err);
          if (isLikelyOfflineError(err)) {
            // Network failure is NOT an authorization denial: keep the session
            // and retry instead of wiping the shared Firebase auth state.
            setOfflineNotice("You appear to be offline. Your session is kept — retrying automatically when you're back online.");
            setLoginError("");
          } else {
            setLoginError("An error occurred while verifying your administrator role.");
            await signOut(auth);
            setAdminUser(null);
            setAdminRole(null);
          }
        }
      } else {
        setOfflineNotice("");
        setAdminUser(null);
      }
      setIsAdminAuthLoading(false);
    });
    return () => {
      window.removeEventListener("online", handleOnline);
      unsubscribe();
    };
  }, [retryTick]);

  const handleAdminLogin = async () => {
    setLoginError("");
    try {
      // Google-only sign-in. Google already verifies the email, so every
      // authenticated staff member satisfies the hardened emailVerified() rule.
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      setLoginError(error.message || "Failed to authenticate");
    }
  };

  const handleAdminLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout failed", error);
    }
  };

  const fetchMenu = async () => {
    try {
      const menuRes = await authedFetch("/api/menu");
      const menuData = await menuRes.json();
      setMenu(menuData);
    } catch (e) {
      console.error("Failed to sync menu state", e);
    }
  };

  useEffect(() => {
    fetchMenu();

    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const updatedOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Order[];
      setOrders(updatedOrders);
    }, (err) => {
      console.warn("Orders query error, falling back to simple collection listener:", err);
      onSnapshot(collection(db, "orders"), (snapshot) => {
        const updatedOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Order[];
        setOrders(updatedOrders);
      }, () => { });
    });

    return () => unsubscribe();
  }, []);

  // Listen for customer accounts (used by CustomerManager + Command Palette).
  useEffect(() => {
    if (!adminUser) return;
    const unsubscribe = onSnapshot(collection(db, "users"), (snapshot) => {
      const usersData = snapshot.docs.map(d => ({ uid: d.id, ...(d.data() as any) })) as UserProfile[];
      setCustomers(usersData);
    }, (err) => {
      console.warn("Users listener unavailable (likely lack of customers.view read access).", err);
    });
    return () => unsubscribe();
  }, [adminUser]);

  // Global Cmd+K / Ctrl+K shortcut to open the command palette.
  useEffect(() => {
    (window as any).__openCommandPalette = () => setCommandPaletteOpen(true);
    return () => { delete (window as any).__openCommandPalette; };
  }, []);

  if (isAdminAuthLoading) {
    return <div className="min-h-screen bg-stone-100 flex items-center justify-center">Loading...</div>;
  }

  if (!adminUser) {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md">
          <div className="flex items-center space-x-3 mb-6">
            <div className="bg-stone-800 p-2 rounded-xl">
              <Settings className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <span className="font-serif text-xl font-bold tracking-tight block leading-none">Admin Portal</span>
              <span className="text-[10px] font-mono tracking-widest text-stone-500 uppercase">Savory Restaurant</span>
            </div>
          </div>
          <div className="space-y-4">
            {offlineNotice && (
              <div className="bg-amber-50 text-amber-800 text-xs p-3 rounded-lg border border-amber-200 flex items-start justify-between gap-2">
                <span>{offlineNotice}</span>
                <button
                  type="button"
                  onClick={() => setRetryTick(t => t + 1)}
                  className="font-bold underline cursor-pointer whitespace-nowrap hover:text-amber-900"
                >
                  Retry
                </button>
              </div>
            )}
            {loginError && (
              <div className="bg-red-50 text-red-600 text-xs p-3 rounded-lg border border-red-100">
                {loginError}
              </div>
            )}
            <button
              type="button"
              onClick={handleAdminLogin}
              className="w-full flex items-center justify-center gap-3 bg-white text-stone-800 font-bold py-3 rounded-lg mt-4 cursor-pointer hover:bg-stone-50 transition-colors border border-stone-300"
            >
              <svg className="w-5 h-5" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
                <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
                <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
                <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
              </svg>
              Continue with Google
            </button>
          </div>

          <div className="mt-6 text-center">
            <button onClick={() => window.location.href = '/'} className="text-xs text-stone-500 hover:text-stone-800 underline">Back to site</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-white border-r border-stone-200 flex-shrink-0 flex flex-col min-h-0 md:min-h-screen static md:sticky md:top-0">
        <div className="p-6 pb-8">
          <span className="font-serif text-2xl font-bold tracking-tight block leading-none">Admin</span>
          <span className="text-[10px] font-mono tracking-widest text-stone-500 uppercase">Savory Restaurant</span>
        </div>

        <nav className="flex-1 px-4 py-2 space-y-5 overflow-y-auto">
          {/* OPERATIONS */}
          {(can('analytics.view') || can('orders.view') || can('kds.view') || can('chat.view')) && (
            <div className="space-y-1">
              <p className="px-2 text-[10px] font-bold uppercase tracking-widest text-stone-400">Operations</p>
              {can('analytics.view') && (
                <button
                  onClick={() => setActiveTab('overview')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'overview' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <LayoutDashboard className="w-4 h-4" />
                  <span>Overview</span>
                </button>
              )}
              {can('orders.view') && (
                <button
                  onClick={() => setActiveTab('orders')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'orders' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <ShoppingBag className="w-4 h-4" />
                  <span>Orders</span>
                </button>
              )}
              {can('kds.view') && (
                <button
                  onClick={() => setActiveTab('kds')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'kds' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <ChefHat className="w-4 h-4" />
                  <span>Kitchen (KDS)</span>
                </button>
              )}
              {can('chat.view') && (
                <button
                  onClick={() => setActiveTab('chat')}
                  className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'chat' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <div className="flex items-center space-x-3">
                    <MessageSquare className="w-4 h-4" />
                    <span>Inbox</span>
                  </div>
                  {totalUnread > 0 && (
                    <span className="bg-amber-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">
                      {totalUnread}
                    </span>
                  )}
                </button>
              )}
            </div>
          )}

          {/* RESTAURANT */}
          {(can('menu.view') || can('reservations.view') || can('promos.view')) && (
            <div className="space-y-1">
              <p className="px-2 text-[10px] font-bold uppercase tracking-widest text-stone-400">Restaurant</p>
              {can('menu.view') && (
                <button
                  onClick={() => setActiveTab('menu')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'menu' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <Utensils className="w-4 h-4" />
                  <span>Menu</span>
                </button>
              )}
              {can('reservations.view') && (
                <button
                  onClick={() => setActiveTab('reservations')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'reservations' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <CalendarDays className="w-4 h-4" />
                  <span>Reservations</span>
                </button>
              )}
              {can('promos.view') && (
                <button
                  onClick={() => setActiveTab('marketing')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'marketing' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <Percent className="w-4 h-4" />
                  <span>Marketing & Promos</span>
                </button>
              )}
            </div>
          )}

          {/* CUSTOMERS & DATA */}
          {(can('customers.view') || can('reports.view')) && (
            <div className="space-y-1">
              <p className="px-2 text-[10px] font-bold uppercase tracking-widest text-stone-400">Customers & Data</p>
              {can('customers.view') && (
                <button
                  onClick={() => setActiveTab('customers')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'customers' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <Users className="w-4 h-4" />
                  <span>Customers</span>
                </button>
              )}
              {can('reports.view') && (
                <button
                  onClick={() => setActiveTab('reports')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'reports' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <FileText className="w-4 h-4" />
                  <span>Reports</span>
                </button>
              )}
            </div>
          )}

          {/* PLATFORM */}
          {(can('team.view') || can('settings.view')) && (
            <div className="space-y-1">
              <p className="px-2 text-[10px] font-bold uppercase tracking-widest text-stone-400">Platform</p>
              {(can('team.view') || can('settings.view')) && (
                <button
                  onClick={() => setActiveTab('settings')}
                  className={`w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${activeTab === 'settings' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                    }`}
                >
                  <Settings className="w-4 h-4" />
                  <span>Team & Settings</span>
                </button>
              )}
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-stone-200">
          <div className="px-4 py-2 mb-2">
            <p className="text-xs text-stone-500">Logged in as</p>
            <p className="text-sm font-bold text-stone-900 truncate">{adminUser?.email}</p>
            <p className="text-[10px] font-mono text-stone-400 uppercase mt-0.5">{adminRole}</p>
          </div>
          <button
            onClick={handleAdminLogout}
            className="w-full flex items-center space-x-3 px-4 py-2.5 rounded-lg text-sm font-medium text-stone-600 hover:bg-stone-50 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Log Out</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        <header className="bg-white border-b border-stone-200 px-8 py-5 flex justify-between items-center sticky top-0 z-10">
          <h1 className="text-2xl font-serif font-bold text-stone-900 capitalize">
            {({ overview: 'Overview', menu: 'Menu', orders: 'Orders', chat: 'Inbox', reservations: 'Reservations', kds: 'Kitchen Display System', marketing: 'Marketing & Promos', settings: 'Team & Settings', customers: 'Customers', reports: 'Reports' } as Record<string, string>)[activeTab] || activeTab}
          </h1>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setCommandPaletteOpen(true)}
              className="hidden sm:flex items-center space-x-2 text-xs text-stone-500 border border-stone-200 rounded-lg px-3 py-1.5 hover:bg-stone-50 transition-colors font-medium cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Search</span>
              <kbd className="font-mono text-[10px] bg-stone-100 border border-stone-200 px-1 rounded">Ctrl K</kbd>
            </button>
            <button
              onClick={() => window.location.href = '/'}
              className="flex items-center space-x-2 text-stone-500 hover:text-stone-900 transition-colors text-sm font-medium cursor-pointer"
            >
              <span>View Live Site</span>
            </button>
          </div>
        </header>

        <div className="p-8 flex-1 overflow-y-auto">
          <ErrorBoundary fallbackTitle="Admin Panel Module Error">
            {activeTab === 'overview' && can('analytics.view') && (
              <div className="animate-fade-in max-w-5xl mx-auto space-y-8">
                <AnalyticsDashboard />
              </div>
            )}

            {activeTab === 'settings' && (can('team.view') || can('settings.view')) && (
              <div className="space-y-8 animate-fade-in max-w-4xl mx-auto">
                {can('team.view') && (
                  <TeamAndRoles
                    currentUserEmail={adminUser?.email || ''}
                    userRole={adminRole}
                    can={can}
                    actor={actor}
                  />
                )}
                {can('settings.view') && (
                  <GlobalSettingsPanel can={can} actor={actor} initialTab={settingsInitialTab} />
                )}
              </div>
            )}

            {activeTab === 'customers' && can('customers.view') && (
              <div className="animate-fade-in max-w-5xl mx-auto">
                <CustomerManager
                  orders={orders}
                  can={can}
                  actor={actor}
                />
              </div>
            )}

            {activeTab === 'reports' && can('reports.view') && (
              <div className="animate-fade-in max-w-5xl mx-auto">
                <ReportsManager
                  orders={orders}
                  menu={menu}
                  can={can}
                />
              </div>
            )}

            {activeTab === 'marketing' && can('promos.view') && (
              <div className="animate-fade-in max-w-5xl mx-auto space-y-8">
                <PromoManager can={can} />
              </div>
            )}

            {activeTab === 'menu' && can('menu.view') && (
              <div className="space-y-8 animate-fade-in max-w-5xl mx-auto">
                <CategoryManager can={can} />
                <MenuManager
                  menu={menu}
                  onMenuUpdated={fetchMenu}
                  userRole={adminRole}
                  can={can}
                  actor={actor}
                />
              </div>
            )}

            {activeTab === 'orders' && can('orders.view') && (
              <div className="animate-fade-in max-w-5xl mx-auto">
                <OrderList
                  orders={orders}
                  onOrderUpdated={() => { }}
                  userRole={adminRole}
                  can={can}
                  actor={actor}
                />
              </div>
            )}

            {activeTab === 'reservations' && can('reservations.view') && (
              <div className="animate-fade-in max-w-5xl mx-auto">
                <ReservationManager can={can} />
              </div>
            )}

            {activeTab === 'chat' && can('chat.view') && (
              <div className="animate-fade-in max-w-5xl mx-auto h-[70vh]">
                <AdminChat can={can} currentStaffName={adminUser?.displayName || ''} />
              </div>
            )}

            {activeTab === 'kds' && can('kds.view') && (
              <div className="animate-fade-in h-[80vh]">
                <KitchenDisplaySystem can={can} />
              </div>
            )}
          </ErrorBoundary>
        </div>
      </main>

      {/* Command Palette - Cmd+K / Ctrl+K */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNavigate={(tab, payload) => {
          if (['overview', 'menu', 'orders', 'chat', 'reservations', 'kds', 'marketing', 'customers', 'reports'].includes(tab)) {
            setActiveTab(tab as any);
          } else if (tab === 'settings') {
            setSettingsInitialTab(payload?.subTab);
            setActiveTab('settings');
          }
        }}
        orders={orders}
        menu={menu}
        customers={customers}
      />
    </div>
  );
}
