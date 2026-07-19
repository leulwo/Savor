import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { Shield, Trash2, UserPlus, CheckCircle, Mail } from 'lucide-react';

export default function TeamManager({ currentUserEmail, userRole }: { currentUserEmail: string, userRole: string | null }) {
  const [team, setTeam] = useState<{email: string, role: string}[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('cashier');
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetchTeam();
  }, []);

  const fetchTeam = async () => {
    const q = query(collection(db, 'admins'));
    const snapshot = await getDocs(q);
    const teamData = snapshot.docs.map(doc => ({ email: doc.id, role: doc.data().role as string }));
    setTeam(teamData);
    setLoading(false);
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail) return;
    
    try {
      const emailLower = newEmail.toLowerCase();
      await setDoc(doc(db, 'admins', emailLower), {
        email: emailLower,
        role: newRole,
        createdAt: new Date().toISOString()
      });
      
      setMessage(`Added ${emailLower} as ${newRole}. They can now set up their password.`);
      setNewEmail('');
      fetchTeam();
      
      setTimeout(() => setMessage(''), 5000);
    } catch (err) {
      console.error(err);
      setMessage('Error adding team member.');
    }
  };

  const handleRemoveMember = async (email: string) => {
    if (email === currentUserEmail) {
      alert("You cannot remove yourself.");
      return;
    }
    
    if (window.confirm(`Are you sure you want to remove ${email}?`)) {
      try {
        await deleteDoc(doc(db, 'admins', email));
        fetchTeam();
      } catch (err) {
        console.error(err);
      }
    }
  };

  if (userRole !== 'admin' && userRole !== 'manager') {
    return null;
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden font-sans mt-8">
      <div className="p-5 border-b border-stone-100 bg-stone-50 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-indigo-100 p-2 rounded-lg text-indigo-700">
            <Shield className="w-5 h-5" />
          </div>
          <h2 className="font-serif text-lg font-bold text-stone-900">Team & Roles</h2>
        </div>
      </div>
      
      <div className="p-6">
        <form onSubmit={handleAddMember} className="mb-8 bg-stone-50 p-4 rounded-xl border border-stone-200">
          <h3 className="text-sm font-bold text-stone-800 mb-3 flex items-center">
            <UserPlus className="w-4 h-4 mr-2" />
            Invite New Team Member
          </h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <input
                type="email"
                placeholder="Email address"
                required
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-amber-500 outline-none"
              />
            </div>
            <div className="w-full sm:w-48">
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value)}
                className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-amber-500 outline-none bg-white"
              >
                <option value="cashier">Cashier</option>
                <option value="kitchen">Kitchen</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              type="submit"
              className="bg-stone-900 text-white px-4 py-2.5 rounded-lg text-sm font-bold hover:bg-stone-800 transition-colors whitespace-nowrap"
            >
              Add Member
            </button>
          </div>
          {message && (
            <p className="text-emerald-600 text-xs mt-3 font-medium flex items-center">
              <CheckCircle className="w-3.5 h-3.5 mr-1" />
              {message}
            </p>
          )}
          <p className="text-stone-500 text-[10px] mt-2 leading-relaxed">
            When you add a team member here, they can go to the Admin Login page and click <strong>"First time setup"</strong> to create their password using this email address.
          </p>
        </form>

        <div className="space-y-3">
          <h3 className="text-sm font-bold text-stone-800 mb-2">Current Team Members</h3>
          {loading ? (
            <div className="text-xs text-stone-500">Loading team...</div>
          ) : (
            <div className="grid gap-3">
              {team.map((member) => (
                <div key={member.email} className="flex items-center justify-between p-3 border border-stone-200 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <div className="bg-stone-100 p-2 rounded-full">
                      <Mail className="w-4 h-4 text-stone-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-stone-900">{member.email}</p>
                      <p className="text-xs text-stone-500 capitalize">{member.role}</p>
                    </div>
                  </div>
                  {member.email !== currentUserEmail && (
                    <button
                      onClick={() => handleRemoveMember(member.email)}
                      className="text-stone-400 hover:text-red-500 transition-colors p-2"
                      title="Remove Member"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                  {member.email === currentUserEmail && (
                    <span className="text-xs font-bold text-stone-400 bg-stone-100 px-2 py-1 rounded">You</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
