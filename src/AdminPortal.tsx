import React, { useState, useEffect } from "react";
import { MenuItem, Order, GlobalSettings } from "./types";
import MenuManager from "./components/MenuManager";
import OrderList from "./components/OrderList";
import CategoryManager from "./components/CategoryManager";
import GlobalSettingsPanel from "./components/GlobalSettingsPanel";
import AnalyticsDashboard from "./components/AnalyticsDashboard";
import AdminChat from "./components/AdminChat";
import ReservationManager from "./components/ReservationManager";
import KitchenDisplaySystem from "./components/KitchenDisplaySystem";
import TeamManager from "./components/TeamManager";
import PromoManager from "./components/PromoManager";
import { Utensils, Settings, LogOut, LayoutDashboard, MessageSquare, CalendarDays, ChefHat, ShoppingBag, Percent } from "lucide-react";
import { db, auth } from "./firebase";
import { collection, query, where, orderBy, onSnapshot, doc, getDoc, setDoc, getDocs } from "firebase/firestore";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from "firebase/auth";

export default function AdminPortal() {
  const [isAdminAuthLoading, setIsAdminAuthLoading] = useState(true);
  const [adminUser, setAdminUser] = useState<any>(null);
  const [adminRole, setAdminRole] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isFirstTimeSetup, setIsFirstTimeSetup] = useState(false);

  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [activeTab, setActiveTab] = useState<'overview' | 'menu' | 'orders' | 'chat' | 'reservations' | 'kds' | 'marketing' | 'settings'>('overview');
  const [totalUnread, setTotalUnread] = useState(0);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
  
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
    // Listen for total messages in the last 24h
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const q = query(
      collection(db, "chat_messages"),
      where("createdAt", ">=", twentyFourHoursAgo),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (activeTab === 'chat') {
        setTotalUnread(0);
        return;
      }

      const messages = snapshot.docs.map(doc => doc.data());
      const unread = messages.filter(m => {
        if (m.role !== 'user') return false;
        const time = m.createdAt?.toMillis ? m.createdAt.toMillis() : 0;
        return time > lastSeenTimestamp;
      }).length;
      
      setTotalUnread(unread);
    });

    return () => unsubscribe();
  }, [activeTab, lastSeenTimestamp]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Only allow email/password authentication
        const isEmailPassword = user.providerData.some(p => p.providerId === "password");
        if (!isEmailPassword) {
          setLoginError("Access denied. Only email/password accounts can access the Admin Portal.");
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

          // Check if admins collection is empty
          const adminsSnapshot = await getDocs(collection(db, "admins"));
          if (adminsSnapshot.empty) {
            // First time bootstrap: Automatically make the logging-in user the first admin!
            const adminRef = doc(db, "admins", emailLower);
            await setDoc(adminRef, {
              email: emailLower,
              role: "admin",
              createdAt: new Date().toISOString()
            });
            setAdminUser(user);
            setAdminRole("admin");
          } else {
            // Check if user is in the admins collection
            const adminDocRef = doc(db, "admins", emailLower);
            const adminDocSnap = await getDoc(adminDocRef);
            if (adminDocSnap.exists()) {
              const role = adminDocSnap.data()?.role;
              if (role === "admin" || role === "manager" || role === "kitchen" || role === "cashier") {
                setAdminUser(user);
                setAdminRole(role);
                if (role === "kitchen") {
                  setActiveTab("kds");
                } else if (role === "cashier") {
                  setActiveTab("orders");
                } else {
                  setActiveTab("overview");
                }
              } else {
                setLoginError(`Access Denied: The account ${emailLower} does not have authorized access.`);
                await signOut(auth);
                setAdminUser(null);
                setAdminRole(null);
              }
            } else {
              setLoginError(`Access Denied: The account ${emailLower} is not authorized.`);
              await signOut(auth);
              setAdminUser(null);
              setAdminRole(null);
            }
          }
        } catch (err: any) {
          console.error("Error verifying admin role:", err);
          setLoginError("An error occurred while verifying your administrator role.");
          await signOut(auth);
          setAdminUser(null);
        }
      } else {
        setAdminUser(null);
      }
      setIsAdminAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    try {
      if (isFirstTimeSetup) {
        // First check if email is in admins collection to give better error message before auth creation
        const emailLower = email.toLowerCase();
        const adminDocRef = doc(db, "admins", emailLower);
        const adminDocSnap = await getDoc(adminDocRef);
        
        if (!adminDocSnap.exists() && emailLower !== "admin@savory.com") { // Keep admin@savory.com as fallback if empty
          const adminsSnapshot = await getDocs(collection(db, "admins"));
          if (!adminsSnapshot.empty) {
            setLoginError(`Access Denied: The account ${emailLower} has not been invited by an admin.`);
            return;
          }
        }
        
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
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
      const snapshot = await getDocs(collection(db, "menu"));
      const menuData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as MenuItem[];
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
    });

    const unsubscribeSettings = onSnapshot(doc(db, "settings", "global"), (doc) => {
      if (doc.exists()) {
        setGlobalSettings(doc.data() as GlobalSettings);
      }
    });

    return () => {
      unsubscribe();
      unsubscribeSettings();
    };
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
              <span className="text-[10px] font-mono tracking-widest text-stone-500 uppercase">{globalSettings?.restaurantName || "Savory Restaurant"}</span>
            </div>
          </div>
          <form onSubmit={handleAdminLogin} className="space-y-4">
            {loginError && (
              <div className="bg-red-50 text-red-600 text-xs p-3 rounded-lg border border-red-100">
                {loginError}
              </div>
            )}
            <div>
              <label className="block text-xs font-bold text-stone-600 uppercase tracking-wide mb-1">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-500 outline-none" required />
            </div>
            <div>
              <label className="block text-xs font-bold text-stone-600 uppercase tracking-wide mb-1">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-amber-500 outline-none" required />
            </div>
            <button type="submit" className="w-full bg-stone-900 text-white font-bold py-3 rounded-lg mt-4 cursor-pointer hover:bg-stone-800 transition-colors">
              {isFirstTimeSetup ? "Create Password & Access Portal" : "Log In"}
            </button>
            <div className="text-center pt-2">
              <button type="button" onClick={() => setIsFirstTimeSetup(!isFirstTimeSetup)} className="text-xs text-amber-600 hover:text-amber-800 font-medium">
                {isFirstTimeSetup ? "Already have a password? Log In" : "First time setup? Create Password"}
              </button>
            </div>
          </form>
          <div className="mt-4 p-3 bg-amber-50/50 border border-amber-100 rounded-lg text-[11px] text-stone-600 leading-normal">
            <p className="font-bold mb-0.5 text-amber-800">Secure Administrator Access</p>
            <p>Access is restricted. If you were invited by an admin, select "First time setup" to create your password.</p>
          </div>
          <div className="mt-6 text-center">
             <button onClick={() => window.location.href = '/'} className="text-xs text-stone-500 hover:text-stone-800 underline">Back to site</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] bg-stone-50 text-stone-900 font-sans flex flex-col md:flex-row overflow-hidden">
      <aside className="w-full md:w-64 bg-white border-b md:border-b-0 md:border-r border-stone-200 flex-shrink-0 flex flex-col z-20 h-auto md:h-full">
        <div className="p-4 md:p-6 md:pb-8 flex justify-between items-center md:block">
          <div>
            <span className="font-serif text-xl md:text-2xl font-bold tracking-tight block leading-none">Admin</span>
            <span className="text-[10px] font-mono tracking-widest text-stone-500 uppercase">{globalSettings?.restaurantName || "Savory Restaurant"}</span>
          </div>
          <button 
            onClick={handleAdminLogout}
            className="md:hidden flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 transition-colors"
          >
            <LogOut className="w-3 h-3" />
            <span>Log Out</span>
          </button>
        </div>
        
        <nav className="flex-1 px-4 md:space-y-1 flex flex-row md:flex-col overflow-x-auto md:overflow-visible gap-2 md:gap-0 pb-2 md:pb-0 scrollbar-hide">
          {(adminRole === 'admin' || adminRole === 'manager') && (
            <button
              onClick={() => setActiveTab('overview')}
              className={`flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap ${
                activeTab === 'overview' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              <span>Overview</span>
            </button>
          )}
          
          {(adminRole === 'admin' || adminRole === 'manager' || adminRole === 'kitchen') && (
            <button
              onClick={() => setActiveTab('menu')}
              className={`flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap ${
                activeTab === 'menu' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
              }`}
            >
              <Utensils className="w-4 h-4" />
              <span>Menu</span>
            </button>
          )}

          {(adminRole === 'admin' || adminRole === 'manager' || adminRole === 'cashier') && (
            <>
              <button
                onClick={() => setActiveTab('orders')}
                className={`flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap ${
                  activeTab === 'orders' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                }`}
              >
                <ShoppingBag className="w-4 h-4" />
                <span>Orders</span>
              </button>
              
              {globalSettings?.enableChatbot !== false && (
                <button
                  onClick={() => setActiveTab('chat')}
                  className={`flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap ${
                    activeTab === 'chat' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                  }`}
                >
                  <div className="flex items-center space-x-2 md:space-x-3">
                    <MessageSquare className="w-4 h-4" />
                    <span>Inbox</span>
                  </div>
                  {totalUnread > 0 && (
                    <span className="bg-amber-500 text-white text-[10px] font-bold w-4 h-4 md:w-5 md:h-5 rounded-full flex items-center justify-center">
                      {totalUnread}
                    </span>
                  )}
                </button>
              )}
              
              {globalSettings?.enableReservations !== false && (
                <button
                  onClick={() => setActiveTab('reservations')}
                  className={`flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap ${
                    activeTab === 'reservations' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
                  }`}
                >
                  <CalendarDays className="w-4 h-4" />
                  <span>Reservations</span>
                </button>
              )}
            </>
          )}

          {(adminRole === 'admin' || adminRole === 'manager' || adminRole === 'kitchen') && (
            <button
              onClick={() => setActiveTab('kds')}
              className={`flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap ${
                activeTab === 'kds' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
              }`}
            >
              <ChefHat className="w-4 h-4" />
              <span>KDS</span>
            </button>
          )}

          {(adminRole === 'admin' || adminRole === 'manager') && (
            <button
              onClick={() => setActiveTab('settings')}
              className={`flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap ${
                activeTab === 'settings' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
              }`}
            >
              <Settings className="w-4 h-4" />
              <span>Settings</span>
            </button>
          )}
          
          {(adminRole === 'admin' || adminRole === 'manager') && globalSettings?.enableMarketing !== false && (
            <button
              onClick={() => setActiveTab('marketing')}
              className={`flex items-center space-x-2 md:space-x-3 px-3 md:px-4 py-2 md:py-2.5 rounded-lg text-xs md:text-sm transition-colors whitespace-nowrap ${
                activeTab === 'marketing' ? 'bg-amber-50 text-amber-900 font-bold' : 'text-stone-600 hover:bg-stone-50 font-medium'
              }`}
            >
              <Percent className="w-4 h-4" />
              <span>Marketing</span>
            </button>
          )}
        </nav>

        <div className="hidden md:block p-4 border-t border-stone-200 mt-auto">
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
      
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <header className="bg-white border-b border-stone-200 px-4 md:px-8 py-3 md:py-5 flex justify-between items-center z-10 shrink-0">
          <h1 className="text-lg md:text-2xl font-serif font-bold text-stone-900 capitalize">
            {activeTab === 'kds' ? 'Kitchen Display System' : activeTab}
          </h1>
          <button 
            onClick={() => window.location.href = '/'}
            className="flex items-center space-x-1 md:space-x-2 text-stone-500 hover:text-stone-900 transition-colors text-xs md:text-sm font-medium cursor-pointer"
          >
            <span>View Live Site</span>
          </button>
        </header>

        <div key={activeTab} className="p-4 md:p-8 flex-1 overflow-y-auto">
          {activeTab === 'overview' && (
            <div className="animate-fade-in max-w-5xl mx-auto space-y-8">
              <AnalyticsDashboard />
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="space-y-8 animate-fade-in max-w-4xl mx-auto">
              <GlobalSettingsPanel />
              <TeamManager currentUserEmail={adminUser?.email || ''} userRole={adminRole} />
            </div>
          )}

          {activeTab === 'marketing' && (
            <div className="animate-fade-in max-w-5xl mx-auto space-y-8">
              <PromoManager />
            </div>
          )}

          {activeTab === 'menu' && (
            <div className="space-y-8 animate-fade-in max-w-5xl mx-auto">
              <CategoryManager />
              <MenuManager 
                menu={menu} 
                onMenuUpdated={fetchMenu} 
                userRole={adminRole}
              />
            </div>
          )}

          {activeTab === 'orders' && (
            <div className="animate-fade-in max-w-5xl mx-auto">
              <OrderList 
                orders={orders} 
                onOrderUpdated={() => {}} 
                userRole={adminRole}
              />
            </div>
          )}

          {activeTab === 'reservations' && (
            <div className="animate-fade-in max-w-5xl mx-auto">
              <ReservationManager />
            </div>
          )}

          {activeTab === 'chat' && (
            <div className="animate-fade-in max-w-5xl mx-auto h-[70vh]">
              <AdminChat />
            </div>
          )}

          {activeTab === 'kds' && (
            <div className="animate-fade-in h-[80vh]">
              <KitchenDisplaySystem />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
