import type { Express, Request } from "express";
import type { LocalStore, LocalTransaction } from "./local-store";
import { isEnvironmentManagedAdmin } from "./primary-admin";
import { createRevisionWriter } from "./sse-security";
import { assertImageFields } from "./image-security";
import { redactServerSecrets, normalizeSettingsFields } from "./config-security";

type Actor = { uid: string; email?: string; email_verified?: boolean; exp?: number };
type Staff = { role: string; permissions: Record<string, boolean>; disabled?: boolean };
type Options = {
  verifyToken: (req: Request) => Promise<Actor | null>;
  resolveStaffPermissions: (email: string, transaction?: LocalTransaction) => Promise<Staff | null>;
  primaryAdminEmail?: string;
};
type Context = { actor: Actor | null; staff: Staff | null; primaryAdminEmail?: string };
type Spec = { path: string; kind: "document" | "collection"; filters?: any[]; orders?: any[]; limit?: number };
const stamp = () => ({ __op: "serverTimestamp" });
const emailKey = (email = "") => email.trim().toLowerCase();
const record = (value: any): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_BATCH_BYTES = 2_097_152;
const MAX_STAFF_MEDIA_DOCUMENT_BYTES = 6 * 1_048_576;
const MAX_STAFF_MEDIA_BATCH_BYTES = 32 * 1_048_576;
const permitted = (ctx: Context, ...permissions: string[]) => !!ctx.staff &&
  (ctx.staff.role === "admin" || permissions.some(permission => ctx.staff!.permissions[permission] === true));
const publicSettings = new Set([
  "restaurantName", "logoUrl", "serviceTaxPercent", "flatFeeETB", "enableCOD", "isOpen",
  "prepTimeMinutes", "scheduledStepsMinutes", "enableMarketing", "enableReservations", "enableChatbot",
  "scheduleEnabled", "openTime", "closeTime", "businessEmail", "businessPhone", "businessAddress", "updatedAt"
]);
const customerPromoFields = new Set(["code", "type", "value", "active", "expiresAt", "minOrderAmount", "maxDiscount", "maxUsages", "usageCount"]);
const promoBookkeepingFields = ["usageCount", "reservedCount", "usedBy", "appliedOrders"];
function fault(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}
function deny(): never { return fault(403, "DATABASE_FORBIDDEN", "You do not have permission to access this data."); }
function validPath(path: any, kind: Spec["kind"]) {
  if (typeof path !== "string" || path.length > 700 || path !== path.trim() ||
    path.split("/").some(part => !part || [".", "..", "__proto__", "constructor", "prototype"].includes(part) || /[\x00-\x1f\\]/.test(part)) ||
    (path.split("/").length % 2 === 0) !== (kind === "document")) {
    fault(400, "DATABASE_INVALID_REQUEST", "Invalid data path.");
  }
  const parts = path.split("/");
  if (parts.length > 2 && !(parts[0] === "users" && parts[2] === "notifications" && parts.length <= 4)) deny();
  return parts;
}
function validData(value: any, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 20 || ++budget.nodes > 20_000) fault(400, "DATABASE_INVALID_REQUEST", "Document nesting or size is too large.");
  if (typeof value === "number" && !Number.isFinite(value)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid numeric field.");
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 1500 || /[\x00-\x1f]/.test(key) || key.split(".").some(part => !part || ["__proto__", "constructor", "prototype"].includes(part))) {
        fault(400, "DATABASE_INVALID_REQUEST", "Invalid document field.");
      }
      validData(item, depth + 1, budget);
    }
  }
}
function validField(field: any): field is string {
  return typeof field === "string" && field.length > 0 && field.length <= 1500 && !/[\x00-\x1f]/.test(field) &&
    !field.split(".").some(part => !part || ["__proto__", "constructor", "prototype"].includes(part));
}
function stringFields(data: any, fields: string[], maximum: number) {
  for (const field of fields) {
    if (data[field] !== undefined && data[field] !== null && (typeof data[field] !== "string" || data[field].length > maximum)) {
      fault(400, "DATABASE_INVALID_REQUEST", `Invalid ${field} field.`);
    }
  }
}
function selectFields(data: any, fields: Set<string>) {
  return Object.fromEntries(Object.entries(data || {}).filter(([key]) => fields.has(key)));
}
function ownFilter(spec: Spec, uid: string) {
  return (spec.filters || []).some(filter => filter.field === "userId" && filter.op === "==" && filter.value === uid);
}
function authorizeRead(ctx: Context, spec: Spec, data?: any) {
  const [collection, id, child] = validPath(spec.path, spec.kind);
  const own = !!ctx.actor && data?.userId === ctx.actor.uid;
  switch (collection) {
    case "menu": case "categories": case "reviews": return;
    case "settings":
      if (permitted(ctx, "settings.view", "settings.edit")) return;
      if (spec.kind === "document" && ["global", "checkout"].includes(id)) return;
      break;
    case "orders":
      if (permitted(ctx, "orders.view", "kds.view", "reports.view", "reports.export", "analytics.view")) return;
      if (ctx.actor && (spec.kind === "collection" ? ownFilter(spec, ctx.actor.uid) : own)) return;
      break;
    case "users":
      if (child === "notifications") { if (ctx.actor?.uid === id) return; break; }
      if (ctx.actor && spec.kind === "document" && ctx.actor.uid === id || permitted(ctx, "customers.view")) return;
      break;
    case "carts": if (spec.kind === "document" && ctx.actor?.uid === id) return; break;
    case "roles": if (ctx.staff) return; break;
    case "admins":
      if (ctx.actor?.email_verified === true && spec.kind === "document" && id === emailKey(ctx.actor.email)) return;
      if (permitted(ctx, "team.view", "team.invite", "roles.edit")) return;
      break;
    case "promoCodes":
      if (permitted(ctx, "promos.view", "promos.manage")) return;
      if (ctx.actor && spec.kind === "document") return;
      break;
    case "reservations":
      if (permitted(ctx, "reservations.view", "reservations.manage")) return;
      if (ctx.actor && (spec.kind === "collection" ? ownFilter(spec, ctx.actor.uid) : own)) return;
      break;
    case "chat_messages":
      if (permitted(ctx, "chat.view", "chat.reply")) return;
      if (ctx.actor && (spec.kind === "collection" ? ownFilter(spec, ctx.actor.uid) : own)) return;
      break;
    case "audit_log": if (permitted(ctx, "audit.view")) return; break;
  }
  deny();
}
function sanitizeRead(ctx: Context, collection: string, data: any) {
  if (!data) return data;
  if (collection === "settings") {
    const safe = redactServerSecrets(data);
    return permitted(ctx, "settings.view", "settings.edit") ? safe : selectFields(safe, publicSettings);
  }
  if (collection === "promoCodes" && !permitted(ctx, "promos.view", "promos.manage")) return selectFields(data, customerPromoFields);
  return data;
}
function onlyKeys(data: any, keys: string[]) {
  if (Object.keys(data).some(key => !keys.includes(key))) deny();
}
function plainDocument(data: any, maximumBytes = MAX_DOCUMENT_BYTES) {
  if (!record(data)) fault(400, "DATABASE_INVALID_REQUEST", "A document object is required.");
  validData(data);
  if (Buffer.byteLength(JSON.stringify(data)) > maximumBytes) fault(413, "DATABASE_INVALID_REQUEST", "The document is too large.");
}
function checkRoleGrant(ctx: Context, data: any) {
  if (data.role !== undefined && (typeof data.role !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(data.role))) fault(400, "DATABASE_INVALID_REQUEST", "Invalid staff role.");
  if (data.permissions !== undefined && (!record(data.permissions) || Object.keys(data.permissions).length > 100 || Object.entries(data.permissions).some(([key, value]) => !validField(key) || typeof value !== "boolean"))) {
    fault(400, "DATABASE_INVALID_REQUEST", "Permissions must be a map of boolean values.");
  }
  for (const field of ["active", "disabled"]) if (data[field] !== undefined && typeof data[field] !== "boolean") fault(400, "DATABASE_INVALID_REQUEST", `Invalid ${field} field.`);
  if (data.status !== undefined && (typeof data.status !== "string" || !["active", "inactive", "disabled"].includes(data.status))) fault(400, "DATABASE_INVALID_REQUEST", "Invalid staff status.");
  if (ctx.staff?.role === "admin") return;
  if (data.role === "admin") deny();
  if (data.permissions && (typeof data.permissions !== "object" || Object.entries(data.permissions).some(([permission, enabled]) =>
    enabled === true && ctx.staff?.permissions[permission] !== true))) deny();
}
function checkMenuWrite(ctx: Context, old: any, data: any, type: string, merge: boolean) {
  if (type === "delete") { if (!permitted(ctx, "menu.delete")) deny(); return; }
  if (!old) { if (!permitted(ctx, "menu.create")) deny(); return; }
  if (ctx.staff?.role === "admin") return;
  const groups: Record<string, string[]> = {
    "menu.edit": ["id", "name", "description", "promoStickers", "image", "galleryImages", "popular", "ingredients", "nutrition", "menuTiming", "timingFrom", "timingTo"],
    "menu.editPrice": ["price", "basePrice"], "menu.editAvailability": ["isActive"], "menu.categories": ["category", "categories"]
  };
  const changed = type === "set" && !merge ? Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(data)])].map(key => [key, data[key]])) : data;
  for (const [field, value] of Object.entries(changed)) {
    if (JSON.stringify(old[field]) === JSON.stringify(value) || field === "updatedAt") continue;
    if (field === "variations") {
      const oldVariants = old.variations ?? [];
      const newVariants = value ?? [];
      if (!Array.isArray(newVariants) || !Array.isArray(oldVariants)) deny();
      if ([...oldVariants, ...newVariants].some(variant => !variant || typeof variant !== "object" || Array.isArray(variant))) fault(400, "DATABASE_INVALID_REQUEST", "Invalid menu variant.");
      const prior = new Map<string, any>(oldVariants.map((variant: any, index: number) => [String(variant.id ?? index), variant]));
      const next = new Map<string, any>(newVariants.map((variant: any, index: number) => [String(variant.id ?? index), variant]));
      if (prior.size !== oldVariants.length || next.size !== newVariants.length) fault(400, "DATABASE_INVALID_REQUEST", "Menu variants require unique IDs.");
      if (prior.size !== next.size && !permitted(ctx, "menu.edit")) deny();
      for (const key of new Set([...prior.keys(), ...next.keys()])) {
        const before: any = prior.get(key) || {};
        const after: any = next.get(key) || {};
        for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
          if (field === "price" ? !permitted(ctx, "menu.editPrice") : field === "isAvailable" ? !permitted(ctx, "menu.editAvailability") : !permitted(ctx, "menu.edit")) deny();
        }
      }
      continue;
    }
    if (!Object.entries(groups).some(([permission, fields]) => fields.includes(field) && permitted(ctx, permission))) deny();
  }
}
export function assertMenuWritePermissions(staff: Staff | null, previous: any, data: any, type: string, merge = false) {
  checkMenuWrite({ actor: null, staff }, previous, data, type, merge);
}
async function authorizedWrite(ctx: Context, write: any, previous: any, tx: LocalTransaction, db: LocalStore) {
  if (!ctx.actor) fault(401, "AUTH_SESSION_EXPIRED", "Please sign in to save changes.");
  const [collection, id, child] = validPath(write.path, "document");
  const removing = write.type === "delete";
  const data = removing ? {} : structuredClone(write.data);
  const mediaWrite = collection === "menu" && permitted(ctx, "menu.create", "menu.edit") || collection === "settings" && permitted(ctx, "settings.edit");
  if (!removing) plainDocument(data, mediaWrite ? MAX_STAFF_MEDIA_DOCUMENT_BYTES : MAX_DOCUMENT_BYTES);
  if (!removing) assertImageFields(data, collection);
  if (["roles", "admins", "promoCodes", "menu"].includes(collection) && Object.keys(data).some(key => key.includes("."))) deny();
  switch (collection) {
    case "orders":
      if (removing && ctx.staff?.role === "admin") return data;
      // Payment truth and fulfillment are written only by dedicated backend routes.
      deny();
      break;
    case "menu": checkMenuWrite(ctx, previous, data, write.type, write.merge === true); return data;
    case "categories": if (!permitted(ctx, "menu.categories")) deny(); return data;
    case "settings": if (!permitted(ctx, "settings.edit")) deny(); return normalizeSettingsFields(data);
    case "users":
      if (child === "notifications") { if (id !== ctx.actor.uid) deny(); return data; }
      stringFields(data, ["uid", "name", "displayName", "email", "phone", "phoneNumber", "block", "room"], 300);
      stringFields(data, ["photoURL", "address", "fcmToken"], 3000);
      if (ctx.staff?.role === "admin") return data;
      if (id !== ctx.actor.uid) deny();
      if (!removing) onlyKeys(data, ["uid", "name", "displayName", "email", "photoURL", "phone", "phoneNumber", "address", "block", "room", "createdAt", "updatedAt", "lastLogin", "fcmToken", "preferences", "savedAddresses", "favoriteItems"]);
      if (data.uid && data.uid !== ctx.actor.uid) deny();
      if (data.email && emailKey(data.email) !== emailKey(ctx.actor.email)) deny();
      return data;
    case "carts": if (id !== ctx.actor.uid) deny(); return data;
    case "roles":
      if (!permitted(ctx, "roles.edit")) deny();
      if (id === "admin" && ctx.primaryAdminEmail) {
        fault(409, "PRIMARY_ADMIN_MANAGED", "The primary admin role always has full access and cannot be edited.");
      }
      if (id === "admin" && ctx.staff?.role !== "admin") deny();
      checkRoleGrant(ctx, data); return data;
    case "admins": {
      if (!permitted(ctx, removing ? "team.remove" : previous ? "roles.edit" : "team.invite")) deny();
      if (id === ctx.primaryAdminEmail || isEnvironmentManagedAdmin(previous)) {
        fault(409, "PRIMARY_ADMIN_MANAGED", "Change PRIMARY_ADMIN_EMAIL on the server and restart the backend to change the primary admin.");
      }
      if (Object.hasOwn(data, "managedBy") || Object.hasOwn(data, "primaryAdmin")) {
        fault(400, "DATABASE_INVALID_REQUEST", "Primary admin markers are managed by the server.");
      }
      if (id !== emailKey(id)) fault(400, "DATABASE_INVALID_REQUEST", "Use a lowercase staff email.");
      if (ctx.staff?.role !== "admin" && (id === emailKey(ctx.actor.email) || previous?.role === "admin")) deny();
      checkRoleGrant(ctx, data);
      const assignedRole = data.role || previous?.role;
      if (!removing && assignedRole && assignedRole !== "admin") {
        const role = (await tx.get(db.collection("roles").doc(assignedRole))).data();
        if (!role) fault(400, "DATABASE_INVALID_REQUEST", "Staff role does not exist.");
        checkRoleGrant(ctx, role);
      }
      if (previous?.role === "admin" && (removing || data.role && data.role !== "admin" || data.active === false || data.disabled === true || ["inactive", "disabled"].includes(data.status))) {
        const admins = await tx.get(db.collection("admins"));
        if (!admins.docs.some(doc => doc.id !== id && doc.data()?.role === "admin" && doc.data()?.active !== false && doc.data()?.disabled !== true && !["inactive", "disabled"].includes(doc.data()?.status))) {
          fault(409, "DATABASE_CONFLICT", "Keep at least one active owner account.");
        }
      }
      return data;
    }
    case "promoCodes":
      if (!permitted(ctx, "promos.manage")) deny();
      if (!removing) {
        for (const field of promoBookkeepingFields) {
          if (!Object.hasOwn(data, field)) continue;
          if (!previous && ["usageCount", "reservedCount"].includes(field) && data[field] === 0) continue;
          if (JSON.stringify(data[field]) !== JSON.stringify(previous?.[field])) deny();
        }
      }
      if (!removing && previous && write.type === "set" && !write.merge) {
        for (const field of promoBookkeepingFields) {
          if (Object.hasOwn(previous, field)) data[field] = previous[field];
        }
      }
      return data;
    case "reviews":
      if (removing) { if (previous?.userId !== ctx.actor.uid && !permitted(ctx, "menu.edit")) deny(); return data; }
      if (previous && previous.userId !== ctx.actor.uid) deny();
      onlyKeys(data, ["userId", "userName", "userPhoto", "customerName", "menuItemId", "rating", "comment", "text", "createdAt", "updatedAt"]);
      stringFields(data, ["userId", "userName", "customerName", "menuItemId"], 300);
      stringFields(data, ["comment", "text", "userPhoto"], 5000);
      if (data.rating !== undefined && (!Number.isInteger(data.rating) || data.rating < 1 || data.rating > 5)) fault(400, "DATABASE_INVALID_REQUEST", "Rating must be between 1 and 5.");
      if (previous && data.menuItemId && data.menuItemId !== previous.menuItemId) deny();
      data.userId = ctx.actor.uid;
      if (!previous) data.createdAt = stamp();
      else if (data.createdAt !== undefined) data.createdAt = previous.createdAt;
      data.updatedAt = stamp(); return data;
    case "reservations":
      stringFields(data, ["userId", "name", "customerName", "customerEmail", "customerPhone", "email", "phone"], 300);
      stringFields(data, ["date", "time", "status"], 40);
      stringFields(data, ["notes"], 5000);
      for (const field of ["guests", "partySize"]) if (data[field] !== undefined && (!Number.isInteger(data[field]) || data[field] < 1 || data[field] > 100)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid reservation party size.");
      if (permitted(ctx, "reservations.manage")) return data;
      if (previous || removing) deny();
      onlyKeys(data, ["userId", "name", "customerName", "customerEmail", "customerPhone", "email", "phone", "date", "time", "guests", "partySize", "notes", "status", "createdAt"]);
      for (const field of ["email", "customerEmail"]) if (data[field] && emailKey(data[field]) !== emailKey(ctx.actor.email)) deny();
      data.userId = ctx.actor.uid; data.status = "pending"; data.createdAt = stamp(); return data;
    case "chat_messages":
      if (previous || removing) deny();
      onlyKeys(data, ["conversationId", "userId", "role", "text", "createdAt", "isRead", "image", "imageUrl", "metadata", "customerName", "senderName"]);
      if (typeof data.conversationId !== "string" || !data.conversationId || typeof data.text !== "string" || data.text.length > 20000) fault(400, "DATABASE_INVALID_REQUEST", "Invalid chat message.");
      if (data.role === "model") {
        if (!permitted(ctx, "chat.reply")) deny();
        const conversation = await tx.get(db.collection("chat_messages").where("conversationId", "==", data.conversationId));
        const owner = conversation.docs.find(doc => doc.data()?.role === "user")?.data()?.userId;
        if (!owner) fault(400, "DATABASE_INVALID_REQUEST", "Conversation does not exist.");
        data.userId = owner;
      } else {
        if (data.role !== "user" || data.userId && data.userId !== ctx.actor.uid) deny();
        const conversation = await tx.get(db.collection("chat_messages").where("conversationId", "==", data.conversationId));
        if (conversation.docs.some(doc => doc.data()?.userId && doc.data()?.userId !== ctx.actor!.uid)) deny();
        data.userId = ctx.actor.uid;
      }
      if (data.isRead !== undefined && typeof data.isRead !== "boolean") fault(400, "DATABASE_INVALID_REQUEST", "Invalid read status.");
      for (const field of ["senderName", "customerName"]) {
        if (data[field] !== undefined && (typeof data[field] !== "string" || data[field].length > 150)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid display name.");
      }
      data.createdAt = stamp(); return data;
    case "audit_log":
      if (!ctx.staff || previous || removing) deny();
      data.actorEmail = emailKey(ctx.actor.email); data.actorRole = ctx.staff.role; data.createdAt = stamp(); return data;
    default: deny();
  }
}

/** Database access replaces browser Firestore rules with backend authorization. */
export function installDatabaseApi(app: Express, db: LocalStore, options: Options) {
  async function context(req: Request): Promise<Context> {
    const supplied = !!req.headers.authorization || !!req.headers["x-firebase-token"];
    const actor = await options.verifyToken(req);
    if (supplied && !actor) fault(401, "AUTH_SESSION_EXPIRED", "Please sign in again.");
    const staff = actor?.email_verified === true ? await options.resolveStaffPermissions(emailKey(actor.email)) : null;
    return { actor, staff: staff?.disabled ? null : staff, primaryAdminEmail: options.primaryAdminEmail };
  }
  function respond(error: any, res: any) {
    const status = error.status || (error.code === "already-exists" ? 409 : error.code === "not-found" ? 404 : error.code === "invalid-argument" ? 400 : 500);
    res.status(status).json({ success: false, code: error.status ? error.code : status === 409 ? "DATABASE_CONFLICT" : status === 500 ? "DATABASE_UNAVAILABLE" : "DATABASE_INVALID_REQUEST", error: status === 500 ? "The local database is temporarily unavailable." : error.message });
    if (status === 500) console.error(JSON.stringify({ event: "local_database_error", code: error.code || "UNKNOWN" }));
  }
  app.post("/api/database/query", async (req, res) => {
    try {
      const ctx = await context(req);
      const spec = req.body as Spec;
      if (!record(spec)) fault(400, "DATABASE_INVALID_REQUEST", "A query object is required.");
      if (!["document", "collection"].includes(spec.kind)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid query kind.");
      if (spec.filters !== undefined && (!Array.isArray(spec.filters) || spec.filters.length > 12) || spec.orders !== undefined && (!Array.isArray(spec.orders) || spec.orders.length > 4)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid query constraints.");
      if (Buffer.byteLength(JSON.stringify(spec)) > 65_536) fault(413, "DATABASE_INVALID_REQUEST", "The query is too large.");
      for (const filter of spec.filters || []) {
        if (!record(filter) || !validField(filter.field) || !["==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains", "array-contains-any"].includes(filter.op)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid query filter.");
        validData(filter.value);
        if (["in", "not-in", "array-contains-any"].includes(filter.op) && (!Array.isArray(filter.value) || !filter.value.length || filter.value.length > 100)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid query filter values.");
      }
      for (const order of spec.orders || []) {
        if (!record(order) || !validField(order.field) || !["asc", "desc"].includes(order.direction)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid query ordering.");
      }
      const parts = validPath(spec.path, spec.kind);
      if (spec.kind === "document") {
        const snapshot = await db.doc(spec.path).get();
        authorizeRead(ctx, spec, snapshot.data());
        return res.json({ id: snapshot.id, exists: snapshot.exists, data: sanitizeRead(ctx, parts[0], snapshot.data()) ?? null, version: snapshot.version });
      }
      authorizeRead(ctx, spec);
      let query = db.collection(spec.path) as any;
      for (const filter of spec.filters || []) {
        query = query.where(filter.field, filter.op, filter.value);
      }
      for (const order of spec.orders || []) {
        query = query.orderBy(order.field, order.direction);
      }
      const maximum = ctx.staff ? 5000 : 1000;
      if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > maximum)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid query limit.");
      query = query.limit(spec.limit ?? maximum);
      const snapshot = await query.get();
      // Recheck every private result, even if a future query implementation
      // changes how filters are combined.
      for (const doc of snapshot.docs) authorizeRead(ctx, { path: doc.ref.path, kind: "document" }, doc.data());
      res.json({ docs: snapshot.docs.map((doc: any) => ({ id: doc.id, path: doc.ref.path, data: sanitizeRead(ctx, parts[0], doc.data()), version: doc.version })) });
    } catch (error) { respond(error, res); }
  });
  app.post("/api/database/commit", async (req, res) => {
    try {
      const ctx = await context(req);
      if (!ctx.actor) fault(401, "AUTH_SESSION_EXPIRED", "Please sign in to save changes.");
      if (!record(req.body)) fault(400, "DATABASE_INVALID_REQUEST", "A write request is required.");
      const batchLimit = permitted(ctx, "menu.create", "menu.edit", "settings.edit") ? MAX_STAFF_MEDIA_BATCH_BYTES : MAX_BATCH_BYTES;
      if (Buffer.byteLength(JSON.stringify(req.body)) > batchLimit) fault(413, "DATABASE_INVALID_REQUEST", "The write batch is too large.");
      const { writes, preconditions = [] } = req.body;
      if (!Array.isArray(writes) || writes.length < 1 || writes.length > 500 || !Array.isArray(preconditions) || preconditions.length > 500) fault(400, "DATABASE_INVALID_REQUEST", "Invalid write batch.");
      const seen = new Set<string>();
      for (const write of writes) {
        if (!record(write) || !["set", "update", "delete"].includes(write.type) || write.merge !== undefined && typeof write.merge !== "boolean") fault(400, "DATABASE_INVALID_REQUEST", "Invalid write operation.");
        validPath(write.path, "document");
        if (seen.has(write.path)) fault(400, "DATABASE_INVALID_REQUEST", "A document can appear only once per batch.");
        seen.add(write.path);
      }
      await db.runTransaction(async tx => {
        // Role and active-account reads participate in the transaction so a
        // concurrent revocation cannot authorize a later database commit.
        const staff = ctx.actor!.email_verified === true ? await options.resolveStaffPermissions(emailKey(ctx.actor!.email), tx) : null;
        ctx.staff = staff?.disabled ? null : staff;
        for (const condition of preconditions) {
          if (!record(condition)) fault(400, "DATABASE_INVALID_REQUEST", "Invalid document precondition.");
          validPath(condition.path, "document");
          if (!Number.isInteger(condition.version) || condition.version < 0) fault(400, "DATABASE_INVALID_REQUEST", "Invalid document version.");
          const existing = await tx.get(db.doc(condition.path));
          authorizeRead(ctx, { path: condition.path, kind: "document" }, existing.data());
          if (existing.version !== condition.version) fault(409, "DATABASE_CONFLICT", "This data changed. Refresh and try again.");
        }
        const prepared = [];
        for (const write of writes) {
          const ref = db.doc(write.path);
          const previous = await tx.get(ref);
          if (write.type === "update" && !previous.exists) fault(404, "DATABASE_INVALID_REQUEST", "Document does not exist.");
          const data = await authorizedWrite(ctx, write, previous.data(), tx, db);
          prepared.push({ write, ref, data });
        }
        if (prepared.some(({ write }) => write.path.startsWith("admins/"))) {
          const admins = await tx.get(db.collection("admins"));
          const finalAdmins = new Map<string, any>(admins.docs.map(doc => [doc.id, doc.data()]));
          for (const { write, data } of prepared.filter(({ write }) => write.path.startsWith("admins/"))) {
            const id = write.path.split("/")[1];
            if (write.type === "delete") finalAdmins.delete(id);
            else finalAdmins.set(id, write.type === "update" || write.merge ? { ...finalAdmins.get(id), ...data } : data);
          }
          if (!Array.from(finalAdmins.values()).some(data => data.role === "admin" && data.active !== false && data.disabled !== true && !["disabled", "inactive"].includes(String(data.status || "").toLowerCase()))) {
            fault(409, "DATABASE_CONFLICT", "Keep at least one active owner account.");
          }
        }
        for (const { write, ref, data } of prepared) {
          if (write.type === "delete") tx.delete(ref);
          else if (write.type === "update") tx.update(ref, data);
          else tx.set(ref, data, { merge: write.merge === true });
        }
      });
      res.json({ success: true, revision: db.currentRevision() });
    } catch (error) { respond(error, res); }
  });
  app.get("/api/database/events", async (req, res) => {
    try {
      const ctx = await context(req);
      res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const stream = createRevisionWriter(res, () => db.currentRevision());
      stream.emit();
      const unsubscribe = db.onChange(stream.emit);
      const heartbeat = setInterval(() => {
        if (ctx.actor?.exp && Date.now() >= ctx.actor.exp * 1000) res.end();
        else stream.heartbeat();
      }, 20000);
      const cleanup = () => { unsubscribe(); clearInterval(heartbeat); stream.close(); };
      res.once("close", cleanup);
      res.once("finish", cleanup);
    } catch (error) { respond(error, res); }
  });
}
