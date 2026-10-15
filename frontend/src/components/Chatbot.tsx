import React, { useState, useEffect, useRef } from "react";
import { Send, MessageCircle, X, Loader2, History, User } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { db } from "../firebase";
import { collection, query, where, orderBy, onSnapshot, addDoc, serverTimestamp, Timestamp } from "../database";

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  createdAt?: any;
}

interface ChatbotProps {
  userId: string;
}

export default function Chatbot({ userId }: ChatbotProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [customerName, setCustomerName] = useState<string | null>(() => localStorage.getItem("savory_customer_name"));
  const [nameInput, setNameInput] = useState("");
  const [conversationId, setConversationId] = useState<string>(() => {
    const saved = localStorage.getItem("savory_conversation_id");
    if (saved) return saved;
    const newId = `chat-${Math.random().toString(36).substring(2, 11)}`;
    localStorage.setItem("savory_conversation_id", newId);
    return newId;
  });
  const [lastSeenTimestamp, setLastSeenTimestamp] = useState<number>(() => {
    const saved = localStorage.getItem("customer_last_seen_chat_time");
    return saved ? parseInt(saved) : Date.now();
  });

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  useEffect(() => {
    if (isOpen) {
      const now = Date.now();
      setLastSeenTimestamp(now);
      localStorage.setItem("customer_last_seen_chat_time", now.toString());
      setUnreadCount(0);
    }
  }, [isOpen]);

  useEffect(() => {
    // Only fetch messages from the last 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const q = query(
      collection(db, "chat_messages"),
      where("userId", "==", userId),
      where("conversationId", "==", conversationId),
      where("createdAt", ">=", twentyFourHoursAgo),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = (snapshot?.docs || []).map(doc => doc.data() || {});
      
      if (isOpen) {
        setUnreadCount(0);
      } else {
        const unread = msgs.filter(m => {
          if (m?.role !== 'model') return false;
          const time = m.createdAt?.toMillis ? m.createdAt.toMillis() : 0;
          return time > lastSeenTimestamp;
        }).length;
        setUnreadCount(unread);
      }
      
      setMessages(msgs.map(m => ({
        role: m.role || 'user',
        text: m.text || '',
        createdAt: m.createdAt
      })));
    });

    return () => unsubscribe();
  }, [conversationId, isOpen, lastSeenTimestamp, userId]);

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim()) return;
    const name = nameInput.trim();
    setCustomerName(name);
    localStorage.setItem("savory_customer_name", name);
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!message.trim() || loading || !customerName) return;

    const userMessage = message.trim();
    setMessage("");
    setLoading(true);

    try {
      // 1. Save user message to the local database
      await addDoc(collection(db, "chat_messages"), {
        conversationId,
        userId,
        role: 'user',
        text: userMessage,
        customerName: customerName,
        createdAt: serverTimestamp()
      });

      // 2. We no longer call the AI backend. 
      // The restaurant staff will see this in their dashboard and reply manually.
      
    } catch (err) {
      console.error("Chat Error:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-[60] font-sans">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            className="absolute bottom-20 right-0 w-[calc(100vw-2rem)] max-w-[400px] h-[min(500px,calc(100dvh-7rem))] origin-bottom-right bg-white border border-stone-200 rounded-3xl shadow-2xl overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="bg-stone-900 p-4 flex justify-between items-center">
              <div className="flex items-center space-x-3 text-white">
                <div className="bg-amber-600 p-2 rounded-xl">
                  <MessageCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-serif font-bold text-sm">Customer Support</h3>
                  <div className="flex items-center text-[10px] text-stone-400">
                    <span className="w-2 h-2 bg-emerald-500 rounded-full mr-1.5 animate-pulse" />
                    Support Online
                  </div>
                </div>
              </div>
              <button 
                onClick={() => setIsOpen(false)}
                className="text-stone-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {!customerName ? (
              <div className="flex-grow flex flex-col items-center justify-center p-8 text-center bg-stone-50">
                <div className="bg-amber-100 p-4 rounded-2xl mb-6">
                  <User className="w-8 h-8 text-amber-600" />
                </div>
                <h4 className="font-serif text-lg font-bold text-stone-900 mb-2">Welcome!</h4>
                <p className="text-stone-500 text-xs mb-6 leading-relaxed">
                  To provide you with better assistance, please tell us your first name.
                </p>
                <form onSubmit={handleSaveName} className="w-full space-y-3">
                  <input
                    type="text"
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="Enter your first name"
                    className="w-full text-xs border border-stone-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-white"
                  />
                  <button
                    type="submit"
                    disabled={!nameInput.trim()}
                    className="w-full bg-stone-900 text-white text-xs font-bold py-3 rounded-xl hover:bg-amber-600 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    Start Chatting
                  </button>
                </form>
              </div>
            ) : (
              <>
                {/* Messages */}
                <div 
                  ref={scrollRef}
                  className="flex-grow overflow-y-auto p-4 space-y-4 bg-stone-50"
                >
                  <div className="text-center py-2">
                    <span className="inline-flex items-center text-[10px] text-stone-400 bg-stone-100 px-2 py-1 rounded-full font-medium">
                      <History className="w-3 h-3 mr-1" />
                      Conversations are cleared every 24 hours
                    </span>
                  </div>

                  {(!messages || messages.length === 0) && (
                    <div className="text-center py-10 px-6">
                      <p className="text-stone-500 text-xs leading-relaxed">
                        Hello {customerName}! Welcome back to Customer Support. Send us a message and our staff will get back to you shortly.
                      </p>
                    </div>
                  )}

                  {(messages || []).map((msg, idx) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div className={`max-w-[85%] p-3 rounded-2xl text-xs leading-relaxed ${
                        msg.role === 'user' 
                          ? 'bg-amber-600 text-white rounded-tr-none shadow-md shadow-amber-600/10' 
                          : 'bg-white text-stone-800 border border-stone-200 rounded-tl-none shadow-sm'
                      }`}>
                        {msg.text}
                      </div>
                    </motion.div>
                  ))}
                  {loading && (
                    <div className="flex justify-start">
                      <div className="bg-white p-3 rounded-2xl rounded-tl-none border border-stone-200 shadow-sm">
                        <Loader2 className="w-4 h-4 text-amber-600 animate-spin" />
                      </div>
                    </div>
                  )}
                </div>

                {/* Input */}
                <form onSubmit={handleSendMessage} className="p-4 bg-white border-t border-stone-100 flex items-center space-x-2">
                  <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Type your message..."
                    className="flex-grow text-xs border border-stone-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-stone-50/50"
                  />
                  <button
                    disabled={!message.trim() || loading}
                    type="submit"
                    className="bg-stone-900 text-white p-2.5 rounded-xl hover:bg-amber-600 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setIsOpen(!isOpen)}
        className="bg-stone-900 text-white p-4 rounded-full shadow-2xl hover:bg-amber-600 transition-all transform hover:scale-105 active:scale-95 cursor-pointer border-2 border-white/10 relative"
      >
        {isOpen ? <X className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
        {!isOpen && unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-amber-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-white animate-bounce">
            {unreadCount}
          </span>
        )}
      </button>
    </div>
  );
}
