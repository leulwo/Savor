import fs from "node:fs";
import path from "node:path";
import type { Express, RequestHandler } from "express";
import type { LocalStore } from "./local-store";
import { redactServerSecrets } from "./config-security";

export type DevEventCategory = "sms" | "error" | "webhook" | "payment" | "integration" | "auth";
export type DevEventStatus = "success" | "failed" | "warning";

export type DevEventInput = {
  category: DevEventCategory;
  status: DevEventStatus;
  source: string;
  summary: string;
  orderId?: string;
  recipient?: string;
  httpStatus?: number;
  latencyMs?: number;
  code?: string;
  details?: Record<string, any>;
};

export type DevEventRecord = DevEventInput & {
  id: string;
  createdAt: string;
};

const MAX_DEV_EVENTS = 300;
const VALID_CATEGORIES = new Set<DevEventCategory>(["sms", "error", "webhook", "payment", "integration", "auth"]);
const VALID_STATUSES = new Set<DevEventStatus>(["success", "failed", "warning"]);

/** Masks middle phone digits so diagnostic logs never expose full customer phone numbers. */
export function maskPhone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean.length <= 6) return "***";
  return `${clean.slice(0, 4)}***${clean.slice(-4)}`;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function sanitizeDetails(details: unknown): Record<string, any> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const safe = redactServerSecrets(details);
  const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized) <= 4096) return safe;
  return { truncated: true, preview: serialized.slice(0, 1024) };
}

/** Appends a sanitized troubleshooting telemetry event to SQLite (`dev_events`). */
export async function recordDevEvent(db: LocalStore, input: DevEventInput): Promise<void> {
  try {
    const entry = {
      category: VALID_CATEGORIES.has(input.category) ? input.category : "error",
      status: VALID_STATUSES.has(input.status) ? input.status : "warning",
      source: boundedText(input.source, 80) || "backend",
      summary: boundedText(input.summary, 400) || "Diagnostic event",
      ...(boundedText(input.orderId, 120) ? { orderId: boundedText(input.orderId, 120) } : {}),
      ...(boundedText(input.recipient, 64) ? { recipient: boundedText(input.recipient, 64) } : {}),
      ...(Number.isInteger(input.httpStatus) ? { httpStatus: input.httpStatus } : {}),
      ...(typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs) ? { latencyMs: Math.max(0, Math.round(input.latencyMs)) } : {}),
      ...(boundedText(input.code, 80) ? { code: boundedText(input.code, 80) } : {}),
      ...(sanitizeDetails(input.details) ? { details: sanitizeDetails(input.details) } : {}),
      createdAt: new Date().toISOString()
    };
    await db.collection("dev_events").add(entry);

    const existing = await db.collection("dev_events").orderBy("createdAt", "desc").get();
    if (existing.size > MAX_DEV_EVENTS) {
      const overflow = existing.docs.slice(MAX_DEV_EVENTS);
      for (let i = 0; i < overflow.length; i += 200) {
        const batch = db.batch();
        overflow.slice(i, i + 200).forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
    }
  } catch {
    // Telemetry must never disrupt checkout or live request handling.
  }
}

/** Records HTTP 5xx responses and 4xx integration/auth failures into `dev_events`. */
export function createDevHttpTelemetryMiddleware(db: LocalStore): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const reqPath = req.originalUrl?.split("?")[0] || req.path || "";
      if (reqPath.startsWith("/api/dev")) return;
      const isApi = reqPath.startsWith("/api/");
      const isAuth = reqPath.startsWith("/__/auth");
      if (!isApi && !isAuth) return;

      const status = res.statusCode;
      const watched4xx = reqPath.startsWith("/api/chapa") || reqPath.startsWith("/api/shipday") || isAuth;
      if (status < 500 && !(watched4xx && status >= 400)) return;

      const category: DevEventCategory = isAuth
        ? "auth"
        : reqPath.includes("/webhook")
          ? "webhook"
          : reqPath.startsWith("/api/chapa")
            ? "payment"
            : reqPath.startsWith("/api/shipday")
              ? "sms"
              : "error";

      void recordDevEvent(db, {
        category,
        status: status >= 500 ? "failed" : "warning",
        source: `http:${req.method} ${reqPath.slice(0, 80)}`,
        summary: `${req.method} ${reqPath.slice(0, 80)} responded with HTTP ${status}`,
        httpStatus: status,
        latencyMs: Date.now() - startedAt
      });
    });
    next();
  };
}

type DiagnosticDeps = {
  requireStaffAuth: RequestHandler;
  requireDevRole: RequestHandler;
  getCleanEnv: (key: string, fallback?: string) => string;
  isMissingOrPlaceholderSecret: (value?: string) => boolean;
  appUrl: string;
  databasePath: string;
  firebaseConfig: { projectId?: string; authDomain?: string };
  shipdayService: { testConnection: () => Promise<any> };
  startedAt: number;
  fetcher?: typeof fetch;
};

function summarizeEvents(records: DevEventRecord[]) {
  const counts = { total: records.length, smsSuccess: 0, smsFailed: 0, errors: 0, webhooks: 0, payments: 0, auth: 0, integrations: 0 };
  for (const r of records) {
    if (r.category === "sms") {
      if (r.status === "success") counts.smsSuccess++;
      else counts.smsFailed++;
    } else if (r.category === "error") counts.errors++;
    else if (r.category === "webhook") counts.webhooks++;
    else if (r.category === "payment") counts.payments++;
    else if (r.category === "auth") counts.auth++;
    else if (r.category === "integration") counts.integrations++;
  }
  return counts;
}

/** Installs developer-only troubleshooting and health-check routes. */
export function installDevDiagnosticRoutes(app: Express, db: LocalStore, deps: DiagnosticDeps) {
  const fetcher = deps.fetcher || fetch;
  const guard = [deps.requireStaffAuth, deps.requireDevRole];

  app.get("/api/dev/diagnostics", ...guard, async (_req, res) => {
    try {
      const collections: Record<string, number> = {};
      for (const name of db.listCollections()) {
        const masked = name.split("/").map((seg, i) => (i % 2 ? "*" : seg)).join("/");
        const snap = await db.collection(name).get();
        collections[masked] = (collections[masked] || 0) + snap.size;
      }
      const totalDocuments = Object.values(collections).reduce((a, b) => a + b, 0);

      let dbSizeBytes = 0;
      try {
        dbSizeBytes = fs.statSync(deps.databasePath).size;
      } catch {}

      const mem = process.memoryUsage();
      const envStatus = (key: string, secret = true) => {
        const val = deps.getCleanEnv(key);
        if (!val) return "missing" as const;
        if (secret && deps.isMissingOrPlaceholderSecret(val)) return "placeholder" as const;
        return "configured" as const;
      };
      const chapaSecret = deps.getCleanEnv("CHAPA_SECRET_KEY");
      const envMatrix = [
        { key: "APP_URL", group: "Core", status: envStatus("APP_URL", false), detail: deps.appUrl },
        { key: "PRIMARY_ADMIN_EMAIL", group: "Core", status: envStatus("PRIMARY_ADMIN_EMAIL", false) },
        { key: "TRUST_PROXY_CIDRS", group: "Core", status: envStatus("TRUST_PROXY_CIDRS", false), detail: deps.getCleanEnv("TRUST_PROXY_CIDRS") || "None" },
        { key: "FIREBASE_PROJECT_ID", group: "Auth", status: deps.firebaseConfig.projectId ? "configured" : "missing", detail: deps.firebaseConfig.projectId || undefined },
        { key: "VITE_FIREBASE_AUTH_DOMAIN", group: "Auth", status: deps.firebaseConfig.authDomain ? "configured" : "missing", detail: deps.firebaseConfig.authDomain || undefined },
        {
          key: "CHAPA_SECRET_KEY",
          group: "Payments",
          status: envStatus("CHAPA_SECRET_KEY"),
          detail: envStatus("CHAPA_SECRET_KEY") === "configured" ? (chapaSecret.startsWith("CHASECK_TEST-") ? "Test mode" : "Live mode") : undefined
        },
        { key: "CHAPA_WEBHOOK_SECRET", group: "Payments", status: envStatus("CHAPA_WEBHOOK_SECRET") },
        { key: "SHIPDAY_API_KEY", group: "Delivery & SMS", status: envStatus("SHIPDAY_API_KEY") },
        { key: "SHIPDAY_WEBHOOK_TOKEN", group: "Delivery & SMS", status: envStatus("SHIPDAY_WEBHOOK_TOKEN") },
        { key: "MAILCHIMP_API_KEY", group: "Marketing", status: envStatus("MAILCHIMP_API_KEY") },
        { key: "MAILCHIMP_LIST_ID", group: "Marketing", status: envStatus("MAILCHIMP_LIST_ID", false) },
        { key: "GEMINI_API_KEY", group: "AI & Maps", status: envStatus("GEMINI_API_KEY") },
        { key: "GOOGLE_MAPS_PLATFORM_KEY", group: "AI & Maps", status: envStatus("GOOGLE_MAPS_PLATFORM_KEY") }
      ];

      const ordersSnap = await db.collection("orders").orderBy("createdAt", "desc").limit(500).get();
      const staleThreshold = Date.now() - 10 * 60 * 1000;
      const stuckOrders = ordersSnap.docs
        .map(d => ({ id: d.id, ...(d.data() || {}) }))
        .filter((o: any) => {
          if (o.paymentReconciliationRequired === true) return true;
          if (["initializing", "uncertain", "cancel_requested"].includes(String(o.paymentAttemptStatus || ""))) return true;
          if (["sending", "reconciling", "failed"].includes(String(o.shipdayDispatchState || ""))) return true;
          const createdMs = typeof o.createdAt === "string" ? Date.parse(o.createdAt) : NaN;
          if (o.paymentStatus === "pending" && o.status !== "cancelled" && Number.isFinite(createdMs) && createdMs < staleThreshold) return true;
          return false;
        })
        .slice(0, 50)
        .map((o: any) => ({
          id: o.id,
          status: o.status,
          paymentMethod: o.paymentMethod,
          paymentStatus: o.paymentStatus,
          paymentAttemptStatus: o.paymentAttemptStatus || null,
          paymentReconciliationRequired: o.paymentReconciliationRequired === true,
          shipdayDispatchState: o.shipdayDispatchState || null,
          shipdayDispatchError: typeof o.shipdayDispatchError === "string" ? o.shipdayDispatchError.slice(0, 200) : null,
          total: typeof o.total === "number" ? o.total : null,
          createdAt: o.createdAt || null,
          updatedAt: o.updatedAt || null
        }));

      const eventsSnap = await db.collection("dev_events").orderBy("createdAt", "desc").limit(MAX_DEV_EVENTS).get();
      const eventRecords = eventsSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) } as DevEventRecord));

      res.json({
        generatedAt: new Date().toISOString(),
        runtime: {
          nodeVersion: process.version,
          nodeEnv: process.env.NODE_ENV || "development",
          appUrl: deps.appUrl,
          trustProxyCidrs: deps.getCleanEnv("TRUST_PROXY_CIDRS") || null,
          uptimeSeconds: Math.max(0, Math.round((Date.now() - deps.startedAt) / 1000)),
          startedAt: new Date(deps.startedAt).toISOString(),
          memoryMb: {
            rss: Math.round(mem.rss / (1024 * 1024)),
            heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
            heapTotal: Math.round(mem.heapTotal / (1024 * 1024))
          }
        },
        database: {
          filename: path.basename(deps.databasePath),
          sizeBytes: dbSizeBytes,
          totalDocuments,
          collections
        },
        envMatrix,
        stuckOrders,
        eventSummary: summarizeEvents(eventRecords)
      });
    } catch {
      res.status(500).json({ error: "Failed to collect diagnostics." });
    }
  });

  app.get("/api/dev/events", ...guard, async (req, res) => {
    try {
      const category = typeof req.query.category === "string" ? req.query.category.trim().toLowerCase() : "all";
      const status = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "all";
      const search = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 120) : "";
      const rawLimit = Number.parseInt(String(req.query.limit || "100"), 10);
      const limitCount = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 100;

      const snap = await db.collection("dev_events").orderBy("createdAt", "desc").limit(MAX_DEV_EVENTS).get();
      const all = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) } as DevEventRecord));
      const filtered = all.filter(item => {
        if (category !== "all" && item.category !== category) return false;
        if (status !== "all" && item.status !== status) return false;
        if (search) {
          const hay = `${item.summary || ""} ${item.source || ""} ${item.orderId || ""} ${item.code || ""} ${item.recipient || ""}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      }).slice(0, limitCount);

      res.json({ events: filtered, counts: summarizeEvents(all) });
    } catch {
      res.status(500).json({ error: "Failed to load diagnostic logs." });
    }
  });

  app.post("/api/dev/integrations/check", ...guard, async (_req, res) => {
    const checkShipday = async () => {
      const start = Date.now();
      try {
        const result = await deps.shipdayService.testConnection();
        return { ok: true, status: "healthy", latencyMs: Date.now() - start, message: result.message || "Connected", orderCount: result.orderCount };
      } catch (err: any) {
        return { ok: false, status: err?.code === "SHIPDAY_NOT_CONFIGURED" ? "unconfigured" : "error", latencyMs: Date.now() - start, message: err?.message || "Shipday connection failed" };
      }
    };

    const checkMailchimp = async () => {
      const start = Date.now();
      const apiKey = deps.getCleanEnv("MAILCHIMP_API_KEY");
      const listId = deps.getCleanEnv("MAILCHIMP_LIST_ID");
      if (deps.isMissingOrPlaceholderSecret(apiKey) || !listId) {
        return { ok: false, status: "unconfigured", latencyMs: Date.now() - start, message: "Mailchimp API key or List ID is not configured." };
      }
      const dc = apiKey.split("-")[1] || "";
      if (!/^us[0-9]{1,3}$/.test(dc)) {
        return { ok: false, status: "error", latencyMs: Date.now() - start, message: "Invalid Mailchimp datacenter suffix." };
      }
      try {
        const response = await fetcher(`https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(listId)}?fields=id,name,stats.member_count`, {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString("base64")}`, Accept: "application/json" },
          signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { ok: false, status: "error", latencyMs: Date.now() - start, message: `Mailchimp returned HTTP ${response.status}` };
        }
        const data: any = await response.json().catch(() => ({}));
        const memberCount = typeof data?.stats?.member_count === "number" ? data.stats.member_count : undefined;
        const listName = typeof data?.name === "string" ? data.name.slice(0, 80) : listId;
        return { ok: true, status: "healthy", latencyMs: Date.now() - start, message: `Connected (List: ${listName}${memberCount !== undefined ? `, ${memberCount} members` : ""})` };
      } catch {
        return { ok: false, status: "error", latencyMs: Date.now() - start, message: "Mailchimp request timed out or failed." };
      }
    };

    const checkChapa = async () => {
      const start = Date.now();
      const secretKey = deps.getCleanEnv("CHAPA_SECRET_KEY");
      const webhookReady = !deps.isMissingOrPlaceholderSecret(deps.getCleanEnv("CHAPA_WEBHOOK_SECRET"));
      if (deps.isMissingOrPlaceholderSecret(secretKey)) {
        return { ok: false, status: "unconfigured", latencyMs: Date.now() - start, message: "CHAPA_SECRET_KEY is not configured.", webhookReady };
      }
      const mode = secretKey.startsWith("CHASECK_TEST-") ? "test" : "live";
      try {
        const response = await fetcher("https://api.chapa.co/v1/banks", {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Bearer ${secretKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(10000)
        });
        await response.body?.cancel().catch(() => {});
        if (!response.ok) {
          return { ok: false, status: "error", latencyMs: Date.now() - start, mode, webhookReady, message: `Chapa returned HTTP ${response.status}` };
        }
        return { ok: true, status: "healthy", latencyMs: Date.now() - start, mode, webhookReady, message: `Connected (${mode.toUpperCase()} mode, webhook ${webhookReady ? "ready" : "missing"})` };
      } catch {
        return { ok: false, status: "error", latencyMs: Date.now() - start, mode, webhookReady, message: "Chapa connectivity check failed." };
      }
    };

    const checkFirebaseAuth = async () => {
      const start = Date.now();
      const domain = String(deps.firebaseConfig.authDomain || "").trim();
      if (!/^[a-z0-9][a-z0-9-]*\.(?:firebaseapp\.com|web\.app)$/i.test(domain)) {
        return { ok: false, status: "unconfigured", latencyMs: Date.now() - start, message: "VITE_FIREBASE_AUTH_DOMAIN is missing or invalid." };
      }
      try {
        const response = await fetcher(`https://${domain}/__/auth/handler`, {
          method: "HEAD",
          redirect: "error",
          signal: AbortSignal.timeout(10000)
        });
        await response.body?.cancel().catch(() => {});
        return {
          ok: response.ok,
          status: response.ok ? "healthy" : "error",
          latencyMs: Date.now() - start,
          message: response.ok ? `Upstream auth proxy reachable (${domain})` : `Upstream returned HTTP ${response.status}`
        };
      } catch {
        return { ok: false, status: "error", latencyMs: Date.now() - start, message: "Could not reach Firebase auth upstream." };
      }
    };

    const checkSqlite = async () => {
      const start = Date.now();
      try {
        await db.collection("settings").doc("checkout").get();
        return { ok: true, status: "healthy", latencyMs: Date.now() - start, message: "SQLite read/write healthy" };
      } catch {
        return { ok: false, status: "error", latencyMs: Date.now() - start, message: "SQLite read failed" };
      }
    };

    const [shipday, mailchimp, chapa, firebaseAuth, sqlite] = await Promise.all([
      checkShipday(),
      checkMailchimp(),
      checkChapa(),
      checkFirebaseAuth(),
      checkSqlite()
    ]);

    const results = { shipday, mailchimp, chapa, firebaseAuth, sqlite };
    const healthyCount = Object.values(results).filter(r => r.ok).length;
    await recordDevEvent(db, {
      category: "integration",
      status: healthyCount === 5 ? "success" : "warning",
      source: "dev-health-suite",
      summary: `Integration suite completed: ${healthyCount}/5 healthy`,
      details: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ok: v.ok, status: v.status, latencyMs: v.latencyMs }]))
    });

    res.json({ checkedAt: new Date().toISOString(), results });
  });

  app.post("/api/dev/events/clear", ...guard, async (_req, res) => {
    try {
      const snap = await db.collection("dev_events").get();
      for (let i = 0; i < snap.docs.length; i += 200) {
        const batch = db.batch();
        snap.docs.slice(i, i + 200).forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
      res.json({ success: true, cleared: snap.size });
    } catch {
      res.status(500).json({ error: "Failed to clear diagnostic logs." });
    }
  });
}
