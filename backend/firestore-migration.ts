import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExportedDocument, LocalStore } from "./local-store";

const MARKER = "_local/firestore-import-v1";
const COLLECTIONS = ["settings", "categories", "menu", "orders", "reservations", "promoCodes", "users", "admins", "roles", "chat_messages", "reviews", "audit_log"];
const EXCLUDED_SCOPES = ["other_user_carts", "other_user_notifications", "backend_idempotency_records"];
const TERMINAL_PAYMENT = new Set(["completed", "refunded", "reversed"]);
type Actor = { uid: string; email?: string; email_verified?: boolean };
type FetchLike = (url: string, options?: RequestInit) => Promise<Response>;
export type FirestoreMigrationOptions = {
  enabled?: boolean;
  verifyToken: (request: Request) => Promise<Actor | null>;
  authorizeLocalAdmin?: (actor: Actor) => Promise<boolean>;
  projectId: string;
  databaseId?: string;
  appRoot: string;
  fetch?: FetchLike;
};

class MigrationError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

function invalidResponse(): never {
  throw new MigrationError("FIRESTORE_MIGRATION_INVALID_RESPONSE", 502, "Firestore returned an invalid migration response. No application data was changed.");
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeFields(fields: any): Record<string, any> {
  if (!record(fields)) invalidResponse();
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) invalidResponse();
    output[key] = decodeValue(value);
  }
  return output;
}

function decodeValue(value: any): any {
  if (!record(value) || Object.keys(value).length !== 1) invalidResponse();
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "stringValue") && typeof value.stringValue === "string") return value.stringValue;
  if (Object.hasOwn(value, "booleanValue") && typeof value.booleanValue === "boolean") return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) {
    const result = Number(value.integerValue);
    if (!Number.isSafeInteger(result)) invalidResponse();
    return result;
  }
  if (Object.hasOwn(value, "doubleValue") && typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if (Object.hasOwn(value, "timestampValue") && typeof value.timestampValue === "string") {
    const match = value.timestampValue.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
    if (!match || !Number.isFinite(Date.parse(match[1] + "Z"))) invalidResponse();
    return { seconds: Math.floor(Date.parse(match[1] + "Z") / 1000), nanoseconds: Number((match[2] || "").padEnd(9, "0")) };
  }
  if (Object.hasOwn(value, "arrayValue") && record(value.arrayValue)) {
    if (value.arrayValue.values !== undefined && !Array.isArray(value.arrayValue.values)) invalidResponse();
    return (value.arrayValue.values || []).map(decodeValue);
  }
  if (Object.hasOwn(value, "mapValue") && record(value.mapValue)) return decodeFields(value.mapValue.fields || {});
  if (Object.hasOwn(value, "bytesValue") && typeof value.bytesValue === "string") return value.bytesValue;
  if (Object.hasOwn(value, "referenceValue") && typeof value.referenceValue === "string") return value.referenceValue;
  if (Object.hasOwn(value, "geoPointValue") && record(value.geoPointValue)) {
    const { latitude, longitude } = value.geoPointValue;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) invalidResponse();
    return { latitude, longitude };
  }
  invalidResponse();
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function legacyBootstrap(appRoot: string): Promise<Map<string, any>> {
  const candidates = new Map<string, any>();
  try {
    const legacy = JSON.parse(await readFile(path.join(appRoot, "data", "db.json"), "utf8"));
    const entries = (collection: string): [string, any][] => {
      const data = legacy[collection];
      return Array.isArray(data) ? data.map(value => [String(value.id || ""), value]) : record(data) ? Object.entries(data) : [];
    };
    for (const collection of ["menu", "categories"]) {
      for (const [id, data] of entries(collection)) {
        if (id && !id.includes("/") && record(data)) candidates.set(`${collection}/${id}`, data);
      }
    }
    for (const [, data] of entries("menu")) {
      for (const value of [data.category, ...(Array.isArray(data.categories) ? data.categories : [])]) {
        if (typeof value !== "string" || !value.trim()) continue;
        const name = value.trim();
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || Buffer.from(name).toString("hex");
        if (!candidates.has(`categories/${id}`)) candidates.set(`categories/${id}`, { name });
      }
    }
  } catch {
    // An absent or malformed legacy file gives no evidence that a record is a sample.
  }
  return candidates;
}

function bearerToken(request: Request): string {
  const authorization = String(request.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] || String(request.headers["x-firebase-token"] || "");
}

/** One-time administrator-authorized copy using Firebase ID tokens, never ADC. */
export function installFirestoreMigration(app: Express, db: LocalStore, options: FirestoreMigrationOptions) {
  // Legacy import is not an authentication/bootstrap path. It must be opted
  // into explicitly and independently authorized by the current local owner.
  if (options.enabled !== true) return;
  if (!options.authorizeLocalAdmin) throw new Error("Firestore migration requires local administrator authorization.");
  const transport = options.fetch || fetch;
  const projectId = String(options.projectId || "");
  const databaseId = String(options.databaseId || "(default)");
  const configured = /^[a-zA-Z0-9_.:-]+$/.test(projectId) && (databaseId === "(default)" || /^[a-zA-Z0-9_.-]+$/.test(databaseId));
  const namePrefix = `projects/${projectId}/databases/${databaseId}/documents/`;
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/`;
  let running = false;

  app.get("/api/database/migration/status", async (request, response) => {
    try {
      const actor = await options.verifyToken(request);
      if (!actor || actor.email_verified !== true || !await options.authorizeLocalAdmin!(actor)) return response.status(403).json({ error: "Only a current local administrator can access migration status." });
      response.json({ completed: (await db.doc(MARKER).get()).exists });
    }
    catch { response.status(503).json({ error: "Migration status is temporarily unavailable." }); }
  });

  app.post("/api/database/migrate-firestore", async (request, response) => {
    let ownsLock = false;
    let stage = "request_validation";
    const requestStartedAt = Date.now();
    console.info(JSON.stringify({ event: "firestore_migration_started" }));
    try {
      if (!configured) throw new MigrationError("FIRESTORE_MIGRATION_NOT_CONFIGURED", 503, "The Firebase project is not configured for migration.");
      if (!record(request.body) || Object.keys(request.body).length) throw new MigrationError("FIRESTORE_MIGRATION_INVALID_REQUEST", 400, "Migration accepts an empty request body only.");
      stage = "firebase_token_verification";
      const authStartedAt = Date.now();
      let authTimer: ReturnType<typeof setTimeout> | undefined;
      const actor = await Promise.race([
        options.verifyToken(request),
        new Promise<Actor | null>((_resolve, reject) => {
          authTimer = setTimeout(() => reject(new MigrationError("FIREBASE_AUTH_TIMEOUT", 503, "Firebase could not verify your sign-in quickly enough. Retry the import.")), 8_000);
        })
      ]).finally(() => { if (authTimer) clearTimeout(authTimer); });
      console.info(JSON.stringify({ event: "firestore_migration_auth", elapsedMs: Date.now() - authStartedAt, verified: Boolean(actor) }));
      const token = bearerToken(request);
      const email = String(actor?.email || "").trim().toLowerCase();
      if (!actor || !token) throw new MigrationError("AUTH_SESSION_EXPIRED", 401, "Sign in again to migrate the database.");
      if (actor.email_verified !== true || !/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(email) || email.length > 254 || !actor.uid || actor.uid.includes("/") || [".", ".."].includes(actor.uid)) {
        throw new MigrationError("FIRESTORE_MIGRATION_FORBIDDEN", 403, "Migration requires a verified Firebase administrator account.");
      }
      if (!await options.authorizeLocalAdmin!(actor)) throw new MigrationError("FIRESTORE_MIGRATION_FORBIDDEN", 403, "Only a current local administrator can migrate data.");
      if (running) throw new MigrationError("FIRESTORE_MIGRATION_IN_PROGRESS", 409, "A database migration is already running. Check its status shortly.");
      running = ownsLock = true;
      const startedAt = Date.now();
      const remote = new Map<string, ExportedDocument>();
      const deadline = startedAt + 120_000;

      async function cloudGet(documentPath: string, query = "", optionalMissing = false): Promise<any | null> {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new MigrationError("FIRESTORE_MIGRATION_TIMEOUT", 504, "The migration timed out. No application data was changed. Try again.");
        const fetchStartedAt = Date.now();
        const collection = documentPath.split("/")[0];
        const urlPath = documentPath.split("/").map(encodeURIComponent).join("/");
        let result: Response | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const attemptRemaining = deadline - Date.now();
          if (attemptRemaining <= 0) throw new MigrationError("FIRESTORE_MIGRATION_TIMEOUT", 504, "The migration timed out. No application data was changed. Try again.");
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.min(15_000, attemptRemaining));
          try {
            result = await transport(base + urlPath + query, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
            if (result.ok || result.status < 500 || attempt === 3) break;
            console.warn(JSON.stringify({ event: "firestore_migration_retry", collection, attempt, statusCode: result.status }));
            await result.body?.cancel();
          } catch (error) {
            const details = error as { name?: unknown; cause?: { code?: unknown } };
            console.warn(JSON.stringify({ event: "firestore_migration_retry", collection, attempt, timedOut: controller.signal.aborted, errorName: String(details?.name || "Error").slice(0, 32), networkCode: String(details?.cause?.code || "").slice(0, 32) }));
            if (controller.signal.aborted) throw new MigrationError("FIRESTORE_MIGRATION_TIMEOUT", 504, "Firestore took too long to respond. No application data was changed. Retry the import.");
            if (attempt === 3) throw new MigrationError("FIRESTORE_MIGRATION_UNAVAILABLE", 502, "Firestore could not complete the migration. No application data was changed.");
            await new Promise(resolve => setTimeout(resolve, 250 * attempt));
          } finally { clearTimeout(timer); }
        }
        if (!result) throw new MigrationError("FIRESTORE_MIGRATION_UNAVAILABLE", 502, "Firestore could not complete the migration. No application data was changed.");
        if (result.status === 404 && optionalMissing) { console.info(JSON.stringify({ event: "firestore_migration_fetch", collection, statusCode: 404, elapsedMs: Date.now() - fetchStartedAt })); return null; }
        if (result.status === 401 || result.status === 403) throw new MigrationError("FIRESTORE_MIGRATION_FORBIDDEN", 403, `Firestore denied access to ${collection}. No application data was changed.`);
        if (!result.ok) throw new MigrationError("FIRESTORE_MIGRATION_UNAVAILABLE", 502, "Firestore could not complete the migration. No application data was changed.");
        if (Number(result.headers.get("content-length") || 0) > 10_000_000) invalidResponse();
        const body = await result.text();
        if (Buffer.byteLength(body) > 10_000_000) invalidResponse();
        try { const parsed = JSON.parse(body); console.info(JSON.stringify({ event: "firestore_migration_fetch", collection, statusCode: result.status, elapsedMs: Date.now() - fetchStartedAt })); return parsed; } catch { invalidResponse(); }
      }

      function decodeDocument(document: any, collection: string, expectedPath?: string): ExportedDocument {
        if (!record(document) || typeof document.name !== "string" || !document.name.startsWith(namePrefix)) invalidResponse();
        const docPath = document.name.slice(namePrefix.length);
        const segments = docPath.split("/");
        if (segments.some(segment => !segment) || segments.length !== collection.split("/").length + 1 || !docPath.startsWith(collection + "/") || (expectedPath && docPath !== expectedPath)) invalidResponse();
        return { path: docPath, data: decodeFields(document.fields || {}) };
      }

      function remember(document: ExportedDocument) {
        if (remote.has(document.path)) invalidResponse();
        if (remote.size >= 10_000) throw new MigrationError("FIRESTORE_MIGRATION_LIMIT", 413, "The database exceeds the migration limit. No application data was changed.");
        remote.set(document.path, document);
      }

      async function readCollection(collection: string, optionalMissing = false) {
        let pageToken = "";
        const seen = new Set<string>();
        do {
          const query = new URLSearchParams({ pageSize: "1000" });
          if (pageToken) query.set("pageToken", pageToken);
          const body = await cloudGet(collection, "?" + query.toString(), optionalMissing);
          if (body === null) return;
          if (!record(body) || (body.documents !== undefined && !Array.isArray(body.documents)) || (body.nextPageToken !== undefined && typeof body.nextPageToken !== "string")) invalidResponse();
          for (const document of body.documents || []) remember(decodeDocument(document, collection));
          pageToken = body.nextPageToken || "";
          if (pageToken && seen.has(pageToken)) invalidResponse();
          if (pageToken) seen.add(pageToken);
        } while (pageToken);
      }

      // The cloud role is checked with the same Firebase token and original rules.
      stage = "cloud_admin_authorization";
      const cloudAdmin = await cloudGet(`admins/${email}`, "", true);
      const admin = cloudAdmin && decodeDocument(cloudAdmin, "admins", `admins/${email}`).data;
      if (!admin || admin.role !== "admin" || admin.active === false || admin.disabled === true || ["inactive", "disabled"].includes(String(admin.status || "").trim().toLowerCase())) {
        throw new MigrationError("FIRESTORE_MIGRATION_FORBIDDEN", 403, "Only an active administrator in the original Firestore database can migrate it.");
      }
      if ((await db.doc(MARKER).get()).exists) return response.json({ success: true, completed: true, alreadyCompleted: true, excludedScopes: EXCLUDED_SCOPES });

      stage = "firestore_collection_reads";
      // Small parallel groups keep reads bounded without queuing every collection.
      for (let index = 0; index < COLLECTIONS.length; index += 3) {
        const reads = await Promise.allSettled(COLLECTIONS.slice(index, index + 3).map(collection => readCollection(collection)));
        const rejected = reads.find(result => result.status === "rejected") as PromiseRejectedResult | undefined;
        if (rejected) throw rejected.reason;
      }
      const cartPath = `carts/${actor.uid}`;
      const ownerCart = await cloudGet(cartPath, "", true);
      if (ownerCart) remember(decodeDocument(ownerCart, "carts", cartPath));
      await readCollection(`users/${actor.uid}/notifications`, true);

      stage = "local_backup";
      const bootstrap = await legacyBootstrap(options.appRoot);
      const backupDirectory = path.join(options.appRoot, "data", "backups");
      await mkdir(backupDirectory, { recursive: true });
      const backupFilename = `before-firestore-import-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
      await writeFile(path.join(backupDirectory, backupFilename), JSON.stringify({ format: "savory-local-db-v1", exportedAt: new Date().toISOString(), records: db.exportDocuments() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      stage = "sqlite_commit";
      const summary = await db.runTransaction(async transaction => {
        if ((await transaction.get(db.doc(MARKER))).exists) return { alreadyCompleted: true, importedDocuments: 0, removedBootstrapDocuments: 0, preservedPaymentDocuments: 0 };
        const imported: ExportedDocument[] = [];
        let preservedPaymentDocuments = 0;
        for (const document of remote.values()) {
          const existing = await transaction.get(db.doc(document.path));
          const previous = existing.data();
          const existingPaymentRank = previous?.paymentStatus === "completed" ? 1 : TERMINAL_PAYMENT.has(previous?.paymentStatus) ? 2 : 0;
          const incomingPaymentRank = document.data.paymentStatus === "completed" ? 1 : TERMINAL_PAYMENT.has(document.data.paymentStatus) ? 2 : 0;
          if (document.path.startsWith("orders/") && existing.exists && existingPaymentRank > incomingPaymentRank) {
            // A cloud pending/stale order must never overwrite local paid truth.
            preservedPaymentDocuments++;
            continue;
          }
          imported.push(document);
        }
        const removals: string[] = [];
        for (const [docPath, sample] of bootstrap) {
          if (remote.has(docPath)) continue;
          const existing = await transaction.get(db.doc(docPath));
          if (existing.exists && canonical(existing.data()) === canonical(sample)) removals.push(docPath);
        }
        for (const document of imported) transaction.set(db.doc(document.path), document.data);
        for (const docPath of removals) transaction.delete(db.doc(docPath));
        const counts = { importedDocuments: imported.length, removedBootstrapDocuments: removals.length, preservedPaymentDocuments };
        transaction.create(db.doc(MARKER), { schemaVersion: 1, completedAt: new Date().toISOString(), sourceProjectId: projectId, sourceDatabaseId: databaseId, backupFilename, counts, excludedScopes: EXCLUDED_SCOPES });
        return { alreadyCompleted: false, ...counts };
      });
      console.info(JSON.stringify({ event: "firestore_migration_complete", elapsedMs: Date.now() - requestStartedAt, importedDocuments: summary.importedDocuments, removedBootstrapDocuments: summary.removedBootstrapDocuments, preservedPaymentDocuments: summary.preservedPaymentDocuments }));
      response.json({ success: true, completed: true, ...summary, backupFilename, excludedScopes: EXCLUDED_SCOPES });
    } catch (error) {
      const failure = error instanceof MigrationError ? error : new MigrationError("FIRESTORE_MIGRATION_FAILED", 500, "The migration could not be saved. Existing application data was retained.");
      console.warn(JSON.stringify({ event: "firestore_migration_failed", stage, elapsedMs: Date.now() - requestStartedAt, statusCode: failure.status, code: failure.code }));
      response.status(failure.status).json({ success: false, completed: false, code: failure.code, error: failure.message });
    } finally { if (ownsLock) running = false; }
  });
}
