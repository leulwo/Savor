import React, { useState, useEffect, useRef } from "react";
import { MessageSquare, Send, User, Clock, ChevronRight, History } from "lucide-react";
import { db } from "../firebase";
import { collection, query, where, orderBy, onSnapshot, addDoc, serverTimestamp, limit } from "firebase/firestore";
import { motion, AnimatePresence } from "motion/react";
import { hasPermission, PermissionMap } from "../permissions";

interface AdminChatProps {
  can?: (key: string) => boolean;
  permissions?: PermissionMap;
}

interface ChatMessage {
  conversationId: string;
  role: 'user' | 'model';
  text: string;
  customerName?: string;
  createdAt: any;
}

interface Conversation {
  id: string;
  customerName: string;
  lastMessage: string;
  lastTimestamp: any;
  unreadCount: number;
}

export default function AdminChat({ can, permissions }: AdminChatProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(false);
  const [readCounts, setReadCounts] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem("admin_chat_read_counts");
    return saved ? JSON.parse(saved) : {};
  });

  const canReply = can ? can("chat.reply") : hasPermission(permissions, "chat.reply");

  useEffect(() => {
    localStorage.setItem("admin_chat_read_counts", JSON.stringify(readCounts));
  }, [readCounts]);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedId && (messages || []).length > 0) {
      const customerMessages = (messages || []).filter(m => m?.role === 'user').length;
      setReadCounts(prev => ({ ...prev, [selectedId]: customerMessages }));
    }
  }, [selectedId, messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Listen for all messages in the last 24 hours to build the conversation list
  useEffect(() => {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const q = query(
      collection(db, "chat_messages"),
      where("createdAt", ">=", twentyFourHoursAgo),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const convMap = new Map<string, Conversation>();
      const countsMap = new Map<string, number>();
      
      (snapshot?.docs || []).forEach(doc => {
        const data = doc.data();
        if (!data) return;
        const id = data.conversationId;
        if (!id) return;
        
        // Count customer messages per conversation
        if (data.role === 'user') {
          countsMap.set(id, (countsMap.get(id) || 0) + 1);
        }

        if (!convMap.has(id)) {
          convMap.set(id, {
            id,
            customerName: data.customerName || "Anonymous",
            lastMessage: data.text || "",
            lastTimestamp: data.createdAt,
            unreadCount: 0
          });
        } else if (data.customerName && convMap.get(id)?.customerName === "Anonymous") {
          const existing = convMap.get(id)!;
          convMap.set(id, { ...existing, customerName: data.customerName });
        }
      });

      // Update unread counts
      const updatedConversations = Array.from(convMap.values()).map(conv => {
        const totalCustomerMsgs = countsMap.get(conv.id) || 0;
        const readCount = readCounts[conv.id] || 0;
        return {
          ...conv,
          unreadCount: Math.max(0, totalCustomerMsgs - readCount)
        };
      });

      setConversations(updatedConversations);
    });

    return () => unsubscribe();
  }, [readCounts]);

  // Listen for messages in the selected conversation
  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }

    const q = query(
      collection(db, "chat_messages"),
      where("conversationId", "==", selectedId),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgList = (snapshot?.docs || []).map(doc => doc.data() as ChatMessage);
      setMessages(msgList);
    });

    return () => unsubscribe();
  }, [selectedId]);

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reply.trim() || !selectedId || loading) return;

    const text = reply.trim();
    setReply("");
    setLoading(true);

    try {
      await addDoc(collection(db, "chat_messages"), {
        conversationId: selectedId,
        role: 'model', // 'model' is used for the responder role
        text,
        createdAt: serverTimestamp()
      });
    } catch (err) {
      console.error("Error sending reply:", err);
    } finally {
      setLoading(false);
    }
  };

  const selectedConversation = (conversations || []).find(c => c.id === selectedId);

  return (
    <div className="flex h-[600px] bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
      {/* Sidebar: Conversation List */}
      <div className="w-80 border-r border-stone-100 flex flex-col bg-stone-50/50">
        <div className="p-4 border-b border-stone-100 bg-white">
          <h3 className="font-serif font-bold text-stone-900 flex items-center">
            <MessageSquare className="w-5 h-5 mr-2 text-amber-600" />
            Live Chat
          </h3>
          <p className="text-[10px] text-stone-500 mt-1 flex items-center">
            <History className="w-3 h-3 mr-1" />
            Showing active chats (Last 24h)
          </p>
        </div>
        
        <div className="flex-grow overflow-y-auto">
          {(!conversations || conversations.length === 0) ? (
            <div className="p-10 text-center">
              <div className="bg-stone-100 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                <MessageSquare className="w-6 h-6 text-stone-300" />
              </div>
              <p className="text-stone-400 text-xs">No active conversations</p>
            </div>
          ) : (
            (conversations || []).map((conv) => (
              <button
                key={conv.id}
                onClick={() => setSelectedId(conv.id)}
                className={`w-full p-4 text-left border-b border-stone-100 transition-colors hover:bg-white flex items-start space-x-3 group ${
                  selectedId === conv.id ? 'bg-white ring-1 ring-inset ring-amber-500/10' : ''
                }`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                  selectedId === conv.id ? 'bg-amber-100 text-amber-600' : 'bg-stone-200 text-stone-500 group-hover:bg-stone-300'
                }`}>
                  <User className="w-5 h-5" />
                </div>
                <div className="flex-grow min-w-0">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-bold text-stone-900 truncate pr-2">{conv.customerName}</span>
                    <span className="text-[10px] text-stone-400 flex items-center shrink-0">
                      <Clock className="w-3 h-3 mr-1" />
                      {conv.lastTimestamp?.toDate ? conv.lastTimestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '...'}
                    </span>
                  </div>
                  <div className="flex justify-between items-start">
                    <p className="text-[11px] text-stone-500 line-clamp-1 flex-grow">
                      {conv.lastMessage}
                    </p>
                    {conv.unreadCount > 0 && selectedId !== conv.id && (
                      <span className="ml-2 bg-amber-500 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center shrink-0">
                        {conv.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className={`w-4 h-4 shrink-0 self-center transition-transform ${
                  selectedId === conv.id ? 'text-amber-500 translate-x-1' : 'text-stone-300'
                }`} />
              </button>
            ))
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-grow flex flex-col bg-white">
        {selectedId ? (
          <>
            {/* Chat Header */}
            <div className="p-4 border-b border-stone-100 flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="bg-stone-900 text-white p-2 rounded-xl">
                  <User className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-stone-900">{selectedConversation?.customerName || 'Customer'}</h4>
                  <span className="text-[10px] text-emerald-600 font-medium flex items-center">
                    <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full mr-1.5 animate-pulse" />
                    Customer Online
                  </span>
                </div>
              </div>
            </div>

            {/* Messages List */}
            <div 
              ref={scrollRef}
              className="flex-grow overflow-y-auto p-6 space-y-4 bg-stone-50/30"
            >
              {(messages || []).map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'model' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[70%] group`}>
                    <div className={`text-[9px] mb-1 font-bold uppercase tracking-wider text-stone-400 ${msg.role === 'model' ? 'text-right' : 'text-left'}`}>
                      {msg.role === 'model' ? 'Restaurant (You)' : (msg.customerName || 'Customer')}
                    </div>
                    <div className={`p-3 rounded-2xl text-xs leading-relaxed shadow-sm ${
                      msg.role === 'model'
                        ? 'bg-stone-900 text-white rounded-tr-none'
                        : 'bg-white text-stone-800 border border-stone-200 rounded-tl-none'
                    }`}>
                      {msg.text}
                    </div>
                    <div className={`text-[9px] mt-1 text-stone-300 opacity-0 group-hover:opacity-100 transition-opacity ${msg.role === 'model' ? 'text-right' : 'text-left'}`}>
                      {msg.createdAt?.toDate ? msg.createdAt.toDate().toLocaleTimeString() : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Reply Input */}
            {canReply ? (
              <form onSubmit={handleSendReply} className="p-4 border-t border-stone-100 bg-white flex items-center space-x-3">
                <input
                  type="text"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Type your reply to the customer..."
                  className="flex-grow text-xs bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <button
                  disabled={!reply.trim() || loading}
                  type="submit"
                  className="bg-amber-600 text-white p-3 rounded-xl hover:bg-amber-700 transition-colors disabled:opacity-50 cursor-pointer shadow-lg shadow-amber-600/20"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            ) : (
              <div className="p-4 border-t border-stone-100 bg-white text-[11px] text-stone-400 text-center">
                Read only — you need the "Reply to customers" permission to send messages.
              </div>
            )}
          </>
        ) : (
          <div className="flex-grow flex flex-col items-center justify-center p-10 text-center">
            <div className="bg-stone-50 w-24 h-24 rounded-3xl flex items-center justify-center mb-6 border border-stone-100">
              <MessageSquare className="w-10 h-10 text-stone-200" />
            </div>
            <h3 className="font-serif text-xl font-bold text-stone-900 mb-2">Select a Conversation</h3>
            <p className="text-stone-500 text-sm max-w-xs leading-relaxed">
              Click on a conversation in the sidebar to start chatting with your customers in real-time.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
