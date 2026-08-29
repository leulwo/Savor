import React, { useState, useEffect } from "react";
import { db } from "../firebase";
import { collection, onSnapshot, doc, setDoc, deleteDoc, writeBatch } from "firebase/firestore";
import { confirmDialog } from "../notify";
import { PERMISSION_GROUPS, DEFAULT_ROLES, ALL_PERMISSIONS, RoleDefinition, PermissionMap, hasPermission } from "../permissions";
import { ShieldCheck, Lock, Plus, Trash2, ChevronDown, ChevronUp, Users } from "lucide-react";

interface RoleManagerProps {
  can?: (key: string) => boolean;
}

export default function RoleManager({ can = () => false }: RoleManagerProps) {
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newRoleName, setNewRoleName] = useState("");

  const canEditRoles = can("roles.edit");

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "roles"), (snapshot) => {
      const stored = (snapshot?.docs || []).map(doc => ({ id: doc.id, ...doc.data() } as RoleDefinition));
      if (stored.length === 0) {
        setRoles(DEFAULT_ROLES);
        seedDefaultRoles();
      } else {
        setRoles(stored.filter(r => !!r.id));
      }
      setLoading(false);
    }, (err) => {
      console.error("Failed to load roles", err);
      setRoles(DEFAULT_ROLES);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const seedDefaultRoles = async () => {
    try {
      const batch = writeBatch(db);
      DEFAULT_ROLES.forEach(role => {
        batch.set(doc(db, "roles", role.id), {
          id: role.id,
          name: role.name,
          description: role.description,
          builtin: role.builtin,
          permissions: role.permissions,
        });
      });
      await batch.commit();
      console.log("Seeded default roles");
    } catch (err) {
      console.error("Failed to seed default roles", err);
    }
  };

  const togglePermission = async (roleId: string, key: string) => {
    const role = roles.find(r => r.id === roleId);
    if (!role || role.builtin && roleId === 'admin') return;

    const nextPermissions: PermissionMap = { ...role.permissions };
    nextPermissions[key] = !hasPermission(nextPermissions, key);

    const nextRoles = roles.map(r => r.id === roleId ? { ...r, permissions: nextPermissions } : r);
    setRoles(nextRoles);

    try {
      await setDoc(doc(db, "roles", roleId), {
        id: role.id,
        name: role.name,
        description: role.description,
        builtin: role.builtin,
        permissions: nextPermissions,
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || "Failed to update role." });
    }
  };

  const toggleAllInGroup = async (roleId: string, groupIndex: number, enable: boolean) => {
    const role = roles.find(r => r.id === roleId);
    if (!role || role.builtin && roleId === 'admin') return;

    const group = PERMISSION_GROUPS[groupIndex];
    if (!group) return;

    const nextPermissions: PermissionMap = { ...role.permissions };
    group.permissions.forEach(p => {
      nextPermissions[p.key] = enable;
    });

    const nextRoles = roles.map(r => r.id === roleId ? { ...r, permissions: nextPermissions } : r);
    setRoles(nextRoles);

    try {
      await setDoc(doc(db, "roles", roleId), {
        id: role.id,
        name: role.name,
        description: role.description,
        builtin: role.builtin,
        permissions: nextPermissions,
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || "Failed to update role." });
    }
  };

  const updateRoleMeta = async (roleId: string, patch: Partial<RoleDefinition>) => {
    const role = roles.find(r => r.id === roleId);
    if (!role) return;

    const nextRoles = roles.map(r => r.id === roleId ? { ...r, ...patch } : r);
    setRoles(nextRoles);

    try {
      await setDoc(doc(db, "roles", roleId), {
        id: role.id,
        name: patch.name ?? role.name,
        description: patch.description ?? role.description,
        builtin: role.builtin,
        permissions: role.permissions,
      }, { merge: true });
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || "Failed to rename role." });
    }
  };

  const handleAddRole = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newRoleName.trim();
    if (!name) return;

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    if (!id) {
      setMessage({ type: 'error', text: 'Role id must contain letters or numbers.' });
      return;
    }
    if (roles.some(r => r.id === id)) {
      setMessage({ type: 'error', text: `A role with id "${id}" already exists.` });
      return;
    }

    const newRole: RoleDefinition = {
      id,
      name,
      description: "",
      builtin: false,
      permissions: Object.fromEntries(ALL_PERMISSIONS.map(k => [k, false])),
    };

    try {
      await setDoc(doc(db, "roles", id), {
        id: newRole.id,
        name: newRole.name,
        description: newRole.description,
        builtin: false,
        permissions: newRole.permissions,
      });
      setExpandedRole(id);
      setNewRoleName("");
      setMessage({ type: 'success', text: `Created role "${name}". Toggle permissions below.` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || "Failed to create role." });
    }
  };

  const handleDeleteRole = async (roleId: string) => {
    if (roleId === 'admin') return;
    const role = roles.find(r => r.id === roleId);
    if (!role) return;
    confirmDialog(`Delete the "${role.name}" role? Team members assigned to it will lose their permissions.`, async () => {
      try {
        await deleteDoc(doc(db, "roles", roleId));
        setMessage({ type: 'success', text: `Deleted role "${role.name}".` });
      } catch (err: any) {
        setMessage({ type: 'error', text: err?.message || "Failed to delete role." });
      }
    }, null, "Delete");
  };

  if (loading) {
    return <div className="p-6 text-xs text-stone-500 text-center">Loading roles & permissions...</div>;
  }

  return (
    <div className="bg-white border border-stone-200 rounded-3xl shadow-sm overflow-hidden font-sans">
      <div className="bg-stone-50 border-b border-stone-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="bg-stone-200 p-2 rounded-xl text-stone-700">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-black text-stone-900 uppercase tracking-tight">Roles & Permissions</h2>
            <p className="text-[10px] text-stone-500 font-mono uppercase tracking-widest">Granular access control per role</p>
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

        {!canEditRoles && (
          <div className="p-3 rounded-xl text-xs font-medium bg-stone-50 text-stone-600 border border-stone-200">
            View only — you need the "Edit roles & permissions" permission to make changes.
          </div>
        )}

        {canEditRoles && (
          <form onSubmit={handleAddRole} className="flex flex-col sm:flex-row gap-3 bg-stone-50 p-4 rounded-2xl border border-stone-100">
            <div className="flex-grow">
              <label className="block text-[10px] font-bold text-stone-500 uppercase tracking-wide mb-1">
                New Custom Role Name
              </label>
              <input
                type="text"
                value={newRoleName}
                onChange={e => setNewRoleName(e.target.value)}
                placeholder="e.g. Delivery Manager"
                className="w-full text-xs bg-white border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            </div>
            <button
              type="submit"
              disabled={!newRoleName.trim()}
              className="self-end bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors disabled:opacity-50 cursor-pointer flex items-center space-x-2"
            >
              <Plus className="w-4 h-4" />
              <span>Create Role</span>
            </button>
          </form>
        )}

        <div className="space-y-4">
          {roles.map(role => {
            const isExpanded = expandedRole === role.id;
            const isAdmin = role.id === 'admin';

            return (
              <div key={role.id} className="border border-stone-200 rounded-2xl overflow-hidden">
                <div className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-stone-50/60 transition-colors cursor-pointer" onClick={() => setExpandedRole(isExpanded ? null : role.id)}>
                  <div className="flex items-center space-x-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isAdmin ? 'bg-amber-100 text-amber-700' : 'bg-stone-100 text-stone-600'}`}>
                      {isAdmin ? <Lock className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-bold text-stone-900">{role.name}</span>
                        <span className="inline-block text-[9px] font-mono uppercase bg-stone-100 text-stone-500 px-2 py-0.5 rounded font-bold">{role.id}</span>
                        {role.builtin && (
                          <span className="inline-block text-[9px] font-mono uppercase bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold">Built-in</span>
                        )}
                      </div>
                      {role.description && <p className="text-[11px] text-stone-500 mt-0.5">{role.description}</p>}
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-[10px] font-mono text-stone-400 hidden sm:inline">
                      {Object.values(role.permissions || {}).filter(Boolean).length}/{ALL_PERMISSIONS.length} permissions
                    </span>
                    {canEditRoles && !isAdmin && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteRole(role.id); }}
                        className="p-1.5 text-stone-400 hover:text-rose-600 transition-colors cursor-pointer"
                        title="Delete Role"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-stone-400" /> : <ChevronDown className="w-4 h-4 text-stone-400" />}
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-stone-100 bg-stone-50/50 p-4 space-y-4">
                    {canEditRoles && !isAdmin && (
                      <div className="flex flex-wrap gap-2">
                        <input
                          type="text"
                          defaultValue={role.name}
                          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== role.name) updateRoleMeta(role.id, { name: v }); }}
                          className="text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500 w-48"
                          placeholder="Role name"
                        />
                        <input
                          type="text"
                          defaultValue={role.description}
                          onBlur={(e) => { const v = e.target.value.trim(); if (v !== role.description) updateRoleMeta(role.id, { description: v }); }}
                          className="text-xs bg-white border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500 flex-grow min-w-48"
                          placeholder="Short description"
                        />
                      </div>
                    )}

                    {isAdmin ? (
                      <p className="text-xs text-stone-500 italic">The Admin role always has full access and cannot be modified.</p>
                    ) : (
                      PERMISSION_GROUPS.map((group, gi) => {
                        const enabledCount = group.permissions.filter(p => hasPermission(role.permissions, p.key)).length;
                        const allOn = enabledCount === group.permissions.length;
                        const noneOn = enabledCount === 0;

                        return (
                          <div key={group.group} className="border border-stone-200 rounded-xl bg-white overflow-hidden">
                            <div className="flex items-center justify-between px-3 py-2 bg-stone-50 border-b border-stone-100">
                              <span className="text-[10px] font-bold text-stone-700 uppercase tracking-wider">{group.group}</span>
                              {canEditRoles && (
                                <div className="flex items-center space-x-1">
                                  {noneOn && (
                                    <button
                                      onClick={() => toggleAllInGroup(role.id, gi, true)}
                                      className="text-[9px] font-bold text-stone-500 hover:text-emerald-700 uppercase tracking-wide px-1.5 py-0.5 hover:bg-emerald-50 rounded transition-colors cursor-pointer"
                                    >
                                      Enable all
                                    </button>
                                  )}
                                  {allOn && (
                                    <button
                                      onClick={() => toggleAllInGroup(role.id, gi, false)}
                                      className="text-[9px] font-bold text-stone-500 hover:text-rose-700 uppercase tracking-wide px-1.5 py-0.5 hover:bg-rose-50 rounded transition-colors cursor-pointer"
                                    >
                                      Disable all
                                    </button>
                                  )}
                                  <span className="text-[10px] font-mono text-stone-400 ml-1">{enabledCount}/{group.permissions.length}</span>
                                </div>
                              )}
                            </div>
                            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                              {group.permissions.map(perm => {
                                const enabled = hasPermission(role.permissions, perm.key);
                                return (
                                  <label key={perm.key} className={`flex items-start space-x-2.5 p-2 rounded-lg cursor-pointer transition-colors select-none ${enabled ? 'bg-emerald-50/70 hover:bg-emerald-50' : 'hover:bg-stone-50'}`}>
                                    <input
                                      type="checkbox"
                                      checked={enabled}
                                      disabled={!canEditRoles}
                                      onChange={() => togglePermission(role.id, perm.key)}
                                      className="mt-0.5 w-3.5 h-3.5 accent-emerald-600 cursor-pointer disabled:cursor-not-allowed"
                                    />
                                    <div>
                                      <span className={`block text-xs font-medium ${enabled ? 'text-emerald-900' : 'text-stone-600'}`}>{perm.label}</span>
                                      <span className="block text-[9px] font-mono text-stone-400 mt-0.5">{perm.key}</span>
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>


      </div>
    </div>
  );
}