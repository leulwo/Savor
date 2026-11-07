import React, { useState } from "react";
import { Users, ShieldCheck } from "lucide-react";
import TeamManager from "./TeamManager";
import RoleManager from "./RoleManager";

interface TeamAndRolesProps {
  currentUserEmail?: string;
  userRole?: string | null;
  can?: (key: string) => boolean;
  actor?: { email: string; role: string };
  activeView?: 'team' | 'roles';
  onActiveViewChange?: (view: 'team' | 'roles') => void;
}

export default function TeamAndRoles({ currentUserEmail = '', userRole, can = () => false, actor, activeView, onActiveViewChange }: TeamAndRolesProps) {
  const [tab, setTab] = useState<'team' | 'roles'>('team');
  const currentTab = activeView ?? tab;
  const selectTab = (next: 'team' | 'roles') => {
    setTab(next);
    onActiveViewChange?.(next);
  };

  return (
    <div className="space-y-4">
      {currentTab === 'roles' ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-stone-200 bg-white px-5 py-4 shadow-sm">
          <div>
            <h2 className="font-serif text-xl font-bold text-stone-900">Roles &amp; Permissions</h2>
            <p className="mt-1 text-xs text-stone-500">Manage access rules for each staff role.</p>
          </div>
          <button type="button" onClick={() => selectTab('team')} className="rounded-xl border border-stone-200 px-4 py-2 text-xs font-bold text-stone-700 hover:bg-stone-50">
            Grant Role Access
          </button>
        </div>
      ) : (
      <div className="flex flex-wrap gap-1 bg-white border border-stone-200 p-1.5 rounded-2xl shadow-sm w-fit">
        <button
          onClick={() => selectTab('team')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
            currentTab === 'team' ? 'bg-stone-900 text-white shadow-sm' : 'text-stone-500 hover:text-stone-800 hover:bg-stone-50'
          }`}
        >
          <Users className="w-4 h-4" />
          Grant Role Access
        </button>
        <button
          onClick={() => selectTab('roles')}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer text-stone-500 hover:text-stone-800 hover:bg-stone-50"
        >
          <ShieldCheck className="w-4 h-4" />
          Roles & Permissions
        </button>
      </div>
      )}

      {currentTab === 'team' ? (
        <TeamManager
          currentUserEmail={currentUserEmail}
          userRole={userRole}
          can={can}
          actor={actor}
        />
      ) : (
        <RoleManager can={can} />
      )}
    </div>
  );
}
