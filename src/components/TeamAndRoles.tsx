import React, { useState } from "react";
import { Users, ShieldCheck } from "lucide-react";
import TeamManager from "./TeamManager";
import RoleManager from "./RoleManager";

interface TeamAndRolesProps {
  currentUserEmail?: string;
  userRole?: string | null;
  can?: (key: string) => boolean;
  actor?: { email: string; role: string };
}

export default function TeamAndRoles({ currentUserEmail = '', userRole, can = () => false, actor }: TeamAndRolesProps) {
  const [tab, setTab] = useState<'team' | 'roles'>('team');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 bg-white border border-stone-200 p-1.5 rounded-2xl shadow-sm w-fit">
        <button
          onClick={() => setTab('team')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
            tab === 'team' ? 'bg-stone-900 text-white shadow-sm' : 'text-stone-500 hover:text-stone-800 hover:bg-stone-50'
          }`}
        >
          <Users className="w-4 h-4" />
          Grant Role Access
        </button>
        <button
          onClick={() => setTab('roles')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
            tab === 'roles' ? 'bg-stone-900 text-white shadow-sm' : 'text-stone-500 hover:text-stone-800 hover:bg-stone-50'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          Roles & Permissions
        </button>
      </div>

      {tab === 'team' ? (
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
