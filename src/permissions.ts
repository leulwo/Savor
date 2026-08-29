/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PermissionDef {
  key: string;
  label: string;
}

export interface PermissionGroup {
  group: string;
  permissions: PermissionDef[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    group: "Overview & Analytics",
    permissions: [
      { key: "analytics.view", label: "View dashboard & revenue analytics" },
    ],
  },
  {
    group: "Menu",
    permissions: [
      { key: "menu.view", label: "View menu items" },
      { key: "menu.create", label: "Create new items" },
      { key: "menu.edit", label: "Edit items (name, description, availability)" },
      { key: "menu.editPrice", label: "Edit item prices only" },
      { key: "menu.delete", label: "Delete items" },
      { key: "menu.categories", label: "Manage categories" },
    ],
  },
  {
    group: "Orders",
    permissions: [
      { key: "orders.view", label: "View order list & details" },
      { key: "orders.updateStatus", label: "Update cooking status (preparing / ready)" },
      { key: "orders.markPaid", label: "Update payment status (mark paid)" },
      { key: "orders.cancel", label: "Cancel orders" },
      { key: "orders.receipts", label: "View & print receipts" },
    ],
  },
  {
    group: "Kitchen Display",
    permissions: [
      { key: "kds.view", label: "View kitchen display" },
      { key: "kds.startPreparing", label: "Start preparing new orders" },
      { key: "kds.markReady", label: "Mark orders ready" },
    ],
  },
  {
    group: "Inbox & Chat",
    permissions: [
      { key: "chat.view", label: "View customer inbox" },
      { key: "chat.reply", label: "Reply to customers" },
    ],
  },
  {
    group: "Reservations",
    permissions: [
      { key: "reservations.view", label: "View reservations" },
      { key: "reservations.manage", label: "Confirm / cancel reservations" },
    ],
  },
  {
    group: "Marketing & Promos",
    permissions: [
      { key: "promos.view", label: "View promo codes" },
      { key: "promos.manage", label: "Create, edit or delete promos" },
    ],
  },
  {
    group: "Customers",
    permissions: [
      { key: "customers.view", label: "View customer profiles & history" },
      { key: "customers.editPoints", label: "Adjust customer loyalty points" },
    ],
  },
  {
    group: "Reports",
    permissions: [
      { key: "reports.view", label: "View & export detailed reports" },
    ],
  },
  {
    group: "Team & Settings",
    permissions: [
      { key: "team.view", label: "View team members" },
      { key: "team.invite", label: "Invite team members" },
      { key: "team.remove", label: "Remove team members" },
      { key: "roles.edit", label: "Edit roles & permissions" },
      { key: "settings.view", label: "View restaurant settings" },
      { key: "settings.edit", label: "Edit restaurant settings" },
      { key: "audit.view", label: "View activity audit logs" },
    ],
  },
];

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap(g => g.permissions.map(p => p.key));

export type PermissionMap = Record<string, boolean>;

export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: PermissionMap;
}

function allPermissions(): PermissionMap {
  return Object.fromEntries(ALL_PERMISSIONS.map(key => [key, true]));
}

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    id: "admin",
    name: "Admin",
    description: "Full access to every module and setting.",
    builtin: true,
    permissions: allPermissions(),
  },
  {
    id: "kitchen",
    name: "Kitchen Staff",
    description: "Kitchen display, order visibility and cooking workflow. No menu editing, payments or settings.",
    builtin: true,
    permissions: {
      "menu.view": true,
      "kds.view": true,
      "kds.startPreparing": true,
      "kds.markReady": true,
    },
  },
  {
    id: "cashier",
    name: "Cashier",
    description: "Order management, payments, inbox and reservations. No menu editing, analytics or settings.",
    builtin: true,
    permissions: {
      "menu.view": true,
      "orders.view": true,
      "orders.updateStatus": true,
      "orders.markPaid": true,
      "orders.cancel": true,
      "orders.receipts": true,
      "chat.view": true,
      "chat.reply": true,
      "reservations.view": true,
      "reservations.manage": true,
      "promos.view": true,
      "customers.view": true,
    },
  },
];

export function getDefaultRole(roleId: string): RoleDefinition | undefined {
  return DEFAULT_ROLES.find(r => r.id === roleId);
}

export function hasPermission(permissions: PermissionMap | undefined | null, key: string): boolean {
  return !!permissions && permissions[key] === true;
}

export async function seedDefaultRoles(db: any): Promise<void> {
  try {
    const { collection, getDocs, doc, setDoc } = await import("firebase/firestore");
    const snapshot = await getDocs(collection(db, "roles"));
    const existing = new Set(snapshot.docs.map(d => d.id));
    let wrote = false;
    for (const role of DEFAULT_ROLES) {
      if (!existing.has(role.id)) {
        await setDoc(doc(db, "roles", role.id), {
          id: role.id,
          name: role.name,
          description: role.description,
          builtin: role.builtin,
          permissions: role.permissions,
        });
        wrote = true;
      }
    }
    if (wrote) {
      console.log("Seeded default roles");
    }
  } catch (err) {
    console.warn("Failed to seed default roles:", err);
  }
}