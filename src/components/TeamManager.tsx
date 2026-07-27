import React, { useState, useEffect } from "react";
import { Users, UserPlus, Trash2, Shield } from "lucide-react";
import { db } from "../firebase";
import { collection, onSnapshot, doc, setDoc, deleteDoc } from "firebase/firestore";

interface TeamMember {
    id?: string;
    email: string;
    role: 'admin' | 'manager' | 'kitchen' | 'cashier';
    createdAt?: string;
}

interface TeamManagerProps {
    currentUserEmail?: string;
    userRole?: string | null;
}

export default function TeamManager({ currentUserEmail = '', userRole }: TeamManagerProps) {
    const [team, setTeam] = useState<TeamMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<'admin' | 'manager' | 'kitchen' | 'cashier'>("manager");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    useEffect(() => {
        const unsubscribe = onSnapshot(collection(db, "admins"), (snapshot) => {
            const docs = snapshot?.docs || [];
            const teamList = docs.map(doc => ({ id: doc.id, ...doc.data() } as TeamMember));
            setTeam(teamList);
            setLoading(false);
        }, (err) => {
            console.error("Failed to fetch team members", err);
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    const handleAddMember = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email.trim()) return;

        setIsSubmitting(true);
        setMessage(null);

        const emailLower = email.trim().toLowerCase();

        try {
            await setDoc(doc(db, "admins", emailLower), {
                email: emailLower,
                role,
                createdAt: new Date().toISOString()
            });

            setMessage({ type: 'success', text: `Successfully invited ${emailLower} as ${role}.` });
            setEmail("");
        } catch (err: any) {
            setMessage({ type: 'error', text: err?.message || "Failed to add team member." });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDeleteMember = async (memberEmail: string) => {
        if (memberEmail.toLowerCase() === currentUserEmail.toLowerCase()) {
            alert("You cannot remove your own admin account.");
            return;
        }

        if (!confirm(`Are you sure you want to remove ${memberEmail}?`)) return;

        try {
            await deleteDoc(doc(db, "admins", memberEmail.toLowerCase()));
            setMessage({ type: 'success', text: `Removed ${memberEmail} from team.` });
        } catch (err: any) {
            setMessage({ type: 'error', text: err?.message || "Failed to delete team member." });
        }
    };

    if (loading) {
        return <div className="p-6 text-xs text-stone-500 text-center">Loading team configuration...</div>;
    }

    return (
        <div className="bg-white border border-stone-200 rounded-3xl shadow-sm overflow-hidden font-sans">
            <div className="bg-stone-50 border-b border-stone-200 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                    <div className="bg-stone-200 p-2 rounded-xl text-stone-700">
                        <Users className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="text-sm font-black text-stone-900 uppercase tracking-tight">Team Management</h2>
                        <p className="text-[10px] text-stone-500 font-mono uppercase tracking-widest">Admin & Staff Roles</p>
                    </div>
                </div>
            </div>

            <div className="p-6 space-y-6">
                {message && (
                    <div className={`p-3 rounded-xl text-xs font-medium ${message.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'
                        }`}>
                        {message.text}
                    </div>
                )}

                <form onSubmit={handleAddMember} className="space-y-4 bg-stone-50 p-4 rounded-2xl border border-stone-100">
                    <h3 className="text-xs font-bold text-stone-800 uppercase tracking-wider flex items-center">
                        <UserPlus className="w-4 h-4 mr-1.5 text-amber-600" />
                        Invite Staff Member
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="sm:col-span-2">
                            <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">
                                Staff Email
                            </label>
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="staff@restaurant.com"
                                className="w-full text-xs bg-white border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
                            />
                        </div>

                        <div>
                            <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">
                                Role
                            </label>
                            <select
                                value={role}
                                onChange={e => setRole(e.target.value as any)}
                                className="w-full text-xs bg-white border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
                            >
                                <option value="admin">Admin (Full Access)</option>
                                <option value="manager">Manager</option>
                                <option value="kitchen">Kitchen Staff (KDS Only)</option>
                                <option value="cashier">Cashier (Orders Only)</option>
                            </select>
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={isSubmitting || !email.trim()}
                        className="bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors disabled:opacity-50 cursor-pointer flex items-center space-x-2"
                    >
                        <span>{isSubmitting ? "Inviting..." : "Grant Role Access"}</span>
                    </button>
                </form>

                <div className="space-y-2">
                    <h3 className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                        Current Authorized Personnel ({(team || []).length})
                    </h3>

                    <div className="divide-y divide-stone-100 border border-stone-100 rounded-2xl overflow-hidden bg-white">
                        {(!team || team.length === 0) ? (
                            <div className="p-4 text-xs text-stone-400 text-center">No staff members listed.</div>
                        ) : (
                            (team || []).map(member => (
                                <div key={member.id || member.email} className="p-3.5 flex items-center justify-between hover:bg-stone-50/50 transition-colors">
                                    <div className="flex items-center space-x-3">
                                        <div className="w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center text-stone-600">
                                            <Shield className="w-4 h-4" />
                                        </div>
                                        <div>
                                            <p className="text-xs font-bold text-stone-900">{member.email}</p>
                                            <span className="inline-block text-[9px] font-mono uppercase bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold mt-0.5">
                                                {member.role || 'admin'}
                                            </span>
                                        </div>
                                    </div>

                                    {member.email?.toLowerCase() !== currentUserEmail?.toLowerCase() && (
                                        <button
                                            onClick={() => member.email && handleDeleteMember(member.email)}
                                            className="p-1.5 text-stone-400 hover:text-rose-600 transition-colors cursor-pointer"
                                            title="Revoke Access"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
