import React, { useState, useEffect } from "react";
import { Users, UserPlus, Trash2, Shield } from "lucide-react";
import { db } from "../firebase";
import { collection, onSnapshot, doc, setDoc, deleteDoc } from "firebase/firestore";
import { RoleDefinition, DEFAULT_ROLES } from "../permissions";
import { confirmDialog, toastError } from "../notify";
import { logAudit } from "../utils/auditLogger";

interface TeamMember {
    id?: string;
    email: string;
    role: string;
    createdAt?: string;
}

interface TeamManagerProps {
    currentUserEmail?: string;
    userRole?: string | null;
    can?: (key: string) => boolean;
    actor?: { email: string; role: string };
}

export default function TeamManager({ currentUserEmail = '', userRole, can = () => false, actor }: TeamManagerProps) {
    const [team, setTeam] = useState<TeamMember[]>([]);
    const [roles, setRoles] = useState<RoleDefinition[]>(DEFAULT_ROLES);
    const [loading, setLoading] = useState(true);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<string>("admin");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const canInvite = can("team.invite");
    const canRemove = can("team.remove");

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

    useEffect(() => {
        const unsubscribe = onSnapshot(collection(db, "roles"), (snapshot) => {
            const stored = (snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data() } as RoleDefinition)).filter(r => !!r.id);
            setRoles(stored.length > 0 ? stored : DEFAULT_ROLES);
        }, (err) => {
            console.error("Failed to fetch roles", err);
            setRoles(DEFAULT_ROLES);
        });

        return () => unsubscribe();
    }, []);

    const handleAddMember = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email.trim()) return;

        setIsSubmitting(true);
        setMessage(null);

    const emailLower = email.trim().toLowerCase();
    const roleLabel = roles.find(r => r.id === role)?.name || role;

    confirmDialog(`Grant "${roleLabel}" role access to ${emailLower}?\n\nThey will be able to sign in and use the Admin portal right away.`, async () => {
      try {        await setDoc(doc(db, "admins", emailLower), {
          email: emailLower,
          role,
          createdAt: new Date().toISOString()
        });

        await logAudit(actor || { email: currentUserEmail, role: userRole || 'unknown' }, {
          action: 'Granted team access',
          category: 'team',
          targetId: emailLower,
          details: { role, roleLabel }
        });
        setMessage({ type: 'success', text: `Successfully granted ${emailLower} the "${roleLabel}" role.` });
        setEmail("");
      } catch (err: any) {
        setMessage({ type: 'error', text: err?.message || "Failed to add team member." });
      } finally {
        setIsSubmitting(false);
      }
    }, () => setIsSubmitting(false), "Grant");
  };

    const handleDeleteMember = async (memberEmail: string) => {
        if (memberEmail.toLowerCase() === currentUserEmail.toLowerCase()) {
            toastError("You cannot remove your own admin account.");
            return;
        }

        confirmDialog(`Are you sure you want to remove ${memberEmail}?`, async () => {
            try {
                await deleteDoc(doc(db, "admins", memberEmail.toLowerCase()));
                await logAudit(actor || { email: currentUserEmail, role: userRole || 'unknown' }, {
                    action: 'Revoked team access',
                    category: 'team',
                    targetId: memberEmail.toLowerCase()
                });
                setMessage({ type: 'success', text: `Removed ${memberEmail} from team.` });
            } catch (err: any) {
                setMessage({ type: 'error', text: err?.message || "Failed to delete team member." });
            }
        }, null, "Remove");
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
                        <p className="text-[10px] text-stone-500 font-mono uppercase tracking-widest">Staff Accounts & Roles</p>
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

                {!canInvite && (
                    <div className="p-3 rounded-xl text-xs font-medium bg-stone-50 text-stone-600 border border-stone-200">
                        View only — you need the "Invite team members" permission to add staff.
                    </div>
                )}

                {canInvite && (
                    <form onSubmit={handleAddMember} className="space-y-4 bg-stone-50 p-4 rounded-2xl border border-stone-100">
                        <h3 className="text-xs font-bold text-stone-800 uppercase tracking-wider flex items-center">
                            <UserPlus className="w-4 h-4 mr-1.5 text-amber-600" />
                            Grant Role Access
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
                                    onChange={e => setRole(e.target.value)}
                                    className="w-full text-xs bg-white border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
                                >
                                    {roles.map(r => (
                                        <option key={r.id} value={r.id}>
                                            {r.name} ({r.id})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={isSubmitting || !email.trim()}
                            className="bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors disabled:opacity-50 cursor-pointer flex items-center space-x-2"
                        >
                            <span>{isSubmitting ? "Saving..." : "Grant Role Access"}</span>
                        </button>
                    </form>
                )}

                <div className="space-y-2">
                    <h3 className="text-xs font-bold text-stone-500 uppercase tracking-wider">
                        Current Authorized Personnel ({(team || []).length})
                    </h3>

                    <div className="divide-y divide-stone-100 border border-stone-100 rounded-2xl overflow-hidden bg-white">
                        {(!team || team.length === 0) ? (
                            <div className="p-4 text-xs text-stone-400 text-center">No staff members listed.</div>
                        ) : (
                            (team || []).map(member => {
                                const roleLabel = roles.find(r => r.id === member.role)?.name || member.role || 'admin';
                                return (
                                    <div key={member.id || member.email} className="p-3.5 flex items-center justify-between hover:bg-stone-50/50 transition-colors">
                                        <div className="flex items-center space-x-3">
                                            <div className="w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center text-stone-600">
                                                <Shield className="w-4 h-4" />
                                            </div>
                                            <div>
                                                <p className="text-xs font-bold text-stone-900">{member.email}</p>
                                                <span className="inline-block text-[9px] font-mono uppercase bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold mt-0.5">
                                                    {roleLabel}
                                                </span>
                                            </div>
                                        </div>

                                        {canRemove && member.email?.toLowerCase() !== currentUserEmail?.toLowerCase() && (
                                            <button
                                                onClick={() => member.email && handleDeleteMember(member.email)}
                                                className="p-1.5 text-stone-400 hover:text-rose-600 transition-colors cursor-pointer"
                                                title="Revoke Access"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}