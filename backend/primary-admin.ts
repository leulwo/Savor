import type { LocalStore, LocalTransaction } from "./local-store";

export const PRIMARY_ADMIN_SETTING = "PRIMARY_ADMIN_EMAIL";
export const adminPermissionKeys = [
  "analytics.view", "menu.view", "menu.create", "menu.edit", "menu.editPrice",
  "menu.editAvailability", "menu.delete", "menu.categories", "orders.view",
  "orders.updateStatus", "orders.markPaid", "orders.cancel", "orders.receipts",
  "kds.view", "kds.startPreparing", "kds.markReady", "chat.view", "chat.reply",
  "reservations.view", "reservations.manage", "promos.view", "promos.manage",
  "customers.view", "reports.view", "team.view", "team.invite", "team.remove",
  "roles.edit", "settings.view", "settings.edit", "audit.view", "data.export", "data.clear"
];

export function parsePrimaryAdminEmail(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("PRIMARY_ADMIN_EMAIL must be a single valid email address.");
  const email = value.trim().toLowerCase();
  if (!email) return "";
  if (email.length > 254 || !/^[^\s@/\\<>()[\],:;"]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(email) || /[\u0000-\u001f]/.test(email)) {
    throw new Error("PRIMARY_ADMIN_EMAIL must be a single valid email address.");
  }
  return email;
}

export function isEnvironmentManagedAdmin(data: any): boolean {
  return data?.managedBy === PRIMARY_ADMIN_SETTING || data?.primaryAdmin === true;
}

export function isPrimaryAdminProtectedPath(documentPath: string, primaryEmail: string): boolean {
  return !!primaryEmail && ["admins/" + primaryEmail, "roles/admin"].includes(documentPath);
}

function activeGrant(data: any): boolean {
  return !!data && data.active !== false && data.disabled !== true &&
    (data.active === undefined || typeof data.active === "boolean") && (data.disabled === undefined || typeof data.disabled === "boolean") &&
    (data.status === undefined || typeof data.status === "string" && ["", "active"].includes(data.status.trim().toLowerCase()));
}

/** The environment owns this grant; database rows are derived for the portal. */
export async function syncPrimaryAdmin(db: LocalStore, configuredEmail: string): Promise<void> {
  const email = parsePrimaryAdminEmail(configuredEmail);
  await db.runTransaction(async transaction => {
    const admins = await transaction.get(db.collection("admins"));
    const roleRef = db.doc("roles/admin");
    const role = email ? await transaction.get(roleRef) : null;
    const prior = admins.docs.find(document => document.id === email)?.data();
    // LocalStore requires every read before the first staged write.
    for (const document of admins.docs) {
      if (document.id !== email && isEnvironmentManagedAdmin(document.data())) {
        transaction.delete(document.ref);
      }
    }
    if (!email) return;
    const permissions = Object.fromEntries(adminPermissionKeys.map(key => [key, true]));
    transaction.set(roleRef, {
      ...(role?.data() || {}), id: "admin", name: "Admin", builtin: true,
      description: "Full access to every module and setting.", permissions
    });
    transaction.set(db.doc(`admins/${email}`), {
      ...(prior || {}), email, role: "admin", active: true, disabled: false, status: "active",
      managedBy: PRIMARY_ADMIN_SETTING, primaryAdmin: true,
      createdAt: prior?.createdAt || new Date().toISOString()
    });
  });
}

export async function resolveLocalStaffPermissions(db: LocalStore, email: string, primaryEmail: string, transaction?: LocalTransaction) {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !/^[^\s@/\\<>()[\],:;"]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(normalized)) return null;
  if (primaryEmail && normalized === primaryEmail) return { role: "admin", permissions: {}, disabled: false };
  const ref = db.doc(`admins/${normalized}`);
  const account = (transaction ? await transaction.get(ref) : await ref.get()).data();
  if (!activeGrant(account) || isEnvironmentManagedAdmin(account)) return null;
  const role = account.role;
  if (typeof role !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(role)) return null;
  if (role === "admin") return { role, permissions: {}, disabled: false };
  const roleRef = db.doc(`roles/${role}`);
  const roleAccount = (transaction ? await transaction.get(roleRef) : await roleRef.get()).data();
  if (!activeGrant(roleAccount)) return null;
  const permissions = roleAccount.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return { role, permissions: {}, disabled: false };
  const safePermissions: Record<string, boolean> = Object.fromEntries(Object.entries(permissions)
    .filter(([key, value]) => adminPermissionKeys.includes(key) && value === true).map(([key]) => [key, true] as const));
  return { role, permissions: safePermissions, disabled: false };
}
