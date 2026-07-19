import React, { useState, useEffect } from "react";
import { MenuItem, Order } from "./types";
import MenuManager from "./components/MenuManager";
import OrderList from "./components/OrderList";
import CategoryManager from "./components/CategoryManager";
import CheckoutSettingsPanel from "./components/CheckoutSettingsPanel";
import AdminChat from "./components/AdminChat";
import { Utensils, Settings, LogOut, LayoutDashboard, MessageSquare } from "lucide-react";
import { db, auth } from "./firebase";
import { collection, query, where, orderBy, onSnapshot, doc, getDoc, setDoc, getDocs } from "firebase/firestore";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "firebase/auth";

export default function AdminPortal() {
  const [isAdminAuthLoading, setIsAdminAuthLoading] = useState(true);
  const [adminUser, setAdminUser] = useState<any>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'chat'>('dashboard');
  const [totalUnread, setTotalUnread] = useState(0);
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
          } else {
            // Check if user is in the admins collection
            const adminDocRef = doc(db, "admins", emailLower);
            const adminDocSnap = await getDoc(adminDocRef);
            if (adminDocSnap.exists() && adminDocSnap.data()?.role === "admin") {
              setAdminUser(user);
            } else {
              setLoginError(`Access Denied: The account ${emailLower} is not an authorized administrator.`);
              await signOut(auth);
              setAdminUser(null);
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
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: any) {
      setLoginError(error.message || "Failed to login");
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
      const menuRes = await fetch("/api/menu");
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
    });

    return () => unsubscribe();
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
              Log In
            </button>
          </form>
          <div className="mt-4 p-3 bg-amber-50/50 border border-amber-100 rounded-lg text-[11px] text-stone-600 leading-normal">
            <p className="font-bold mb-0.5 text-amber-800">Secure Administrator Access</p>
            <p>Access is strictly restricted to administrator credentials created in the Firebase Console. Standard customer accounts cannot log in here.</p>
          </div>
          <div className="mt-6 text-center">
             <button onClick={() => window.location.href = '/'} className="text-xs text-stone-500 hover:text-stone-800 underline">Back to site</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 font-sans flex flex-col">
      <header className="bg-stone-900 text-white shadow-md">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-3">
            <div className="bg-stone-800 p-2 rounded-xl">
              <Settings className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <span className="font-serif text-xl font-bold tracking-tight block leading-none">Admin Portal</span>
              <span className="text-[10px] font-mono tracking-widest text-stone-400 uppercase">Savory Restaurant</span>
            </div>
          </div>
          <div className="flex items-center space-x-6">
            <button 
              onClick={() => window.location.href = '/'}
              className="flex items-center space-x-2 text-stone-400 hover:text-white transition-colors text-sm font-medium cursor-pointer"
            >
              <span>Back to Site</span>
            </button>
            <button 
              onClick={handleAdminLogout}
              className="flex items-center space-x-2 text-red-400 hover:text-red-300 transition-colors text-sm font-medium cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Log Out</span>
            </button>
          </div>
        </div>
      </header>
      
      <main className="flex-grow max-w-7xl w-full mx-auto px-6 py-8">
        <div className="flex space-x-1 bg-stone-200 p-1 rounded-xl w-fit mb-8 shadow-sm">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`flex items-center space-x-2 px-6 py-2.5 rounded-lg text-sm font-bold transition-all cursor-pointer ${
              activeTab === 'dashboard' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            <LayoutDashboard className="w-4 h-4" />
            <span>Dashboard</span>
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex items-center space-x-2 px-6 py-2.5 rounded-lg text-sm font-bold transition-all cursor-pointer relative ${
              activeTab === 'chat' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            <MessageSquare className="w-4 h-4" />
            <span>Messages</span>
            {totalUnread > 0 && activeTab !== 'chat' && (
              <span className="absolute -top-1 -right-1 bg-amber-500 text-white text-[10px] font-bold w-4.5 h-4.5 rounded-full flex items-center justify-center border-2 border-stone-200">
                {totalUnread}
              </span>
            )}
          </button>
        </div>

        {activeTab === 'dashboard' ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-8">
              <CheckoutSettingsPanel />
              <CategoryManager />
              <MenuManager 
                menu={menu} 
                onMenuUpdated={fetchMenu} 
              />
            </div>
            <OrderList 
              orders={orders} 
              onOrderUpdated={() => {}} 
            />
          </div>
        ) : (
          <div className="animate-fade-in">
            <AdminChat />
          </div>
        )}
      </main>
    </div>
  );
}
