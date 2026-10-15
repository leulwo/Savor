import type { Express, RequestHandler, ErrorRequestHandler } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import net from "node:net";

export function publicOrigin(value: string, production = false): string {
  if (!value && production) throw new Error("APP_URL is required in production.");
  let url: URL;
  try { url = new URL(value || "http://localhost:3000"); }
  catch { throw new Error("APP_URL must be a valid HTTP(S) origin, including its protocol."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("APP_URL must be an HTTP(S) origin without credentials, a path, or query parameters.");
  }
  if (production && url.protocol !== "https:") throw new Error("Production APP_URL must use HTTPS.");
  return url.origin;
}

export function requestOrigin(req: { headers: Record<string, any> }, configured: string, production: boolean): string {
  if (!production) {
    const host = String(req.headers.host || "");
    if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) {
      try { return new URL(`http://${host}`).origin; } catch { /* Ignore malformed ports. */ }
    }
  }
  // Forwarded host/protocol are never authority for redirects or payment URLs.
  return configured;
}

export function trustedProxies(value = ""): false | string[] {
  if (!value.trim()) return false;
  const entries = value.split(",").map(item => item.trim());
  for (const entry of entries) {
    if (entry === "loopback") continue;
    const [address, prefix, ...extra] = entry.split("/");
    const family = net.isIP(address);
    if (!family || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < (family === 4 ? 8 : 32) || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error("TRUST_PROXY_CIDRS must contain explicit proxy IPs/CIDRs or loopback, never true or a hop count.");
    }
  }
  return entries;
}

export function installHttpSecurity(app: Express, options: { origin: string; production: boolean; proxyCidrs?: string }) {
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.set("trust proxy", trustedProxies(options.proxyCidrs));
  const headers = helmet({
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    strictTransportSecurity: options.production ? { maxAge: 31536000 } : false,
    contentSecurityPolicy: options.production ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://maps.googleapis.com", "https://maps.gstatic.com", "https://apis.google.com", "https://www.gstatic.com"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "https:", "data:", "blob:"],
        connectSrc: ["'self'", "https://*.googleapis.com", "https://*.gstatic.com", "https://*.firebaseapp.com", "https://*.firebaseio.com", "wss://*.firebaseio.com", "https://www.google-analytics.com"],
        frameSrc: ["'self'", "https://*.firebaseapp.com", "https://accounts.google.com", "https://apis.google.com", "https://www.google.com"],
        objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"],
        workerSrc: ["'self'", "blob:"], upgradeInsecureRequests: [],
      },
    } : false,
  });
  app.use((req, res, next) => {
    headers(req, res, () => {
      // Firebase's official same-origin helper has its own policy.
      if (req.path.startsWith("/__/auth/")) res.removeHeader("Content-Security-Policy");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
      if (req.path.startsWith("/api/") || req.path.startsWith("/__/auth/")) res.setHeader("Cache-Control", "no-store");
      next();
    });
  });
  const permittedOrigins = new Set([options.origin]);
  app.use("/api", (req, res, next) => {
    const origin = req.get("origin");
    const provider = ["/chapa/webhook", "/shipday/webhook"].includes(req.path);
    if (provider || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const localOrigin = requestOrigin(req, options.origin, options.production);
    if (origin && !permittedOrigins.has(origin) && origin !== localOrigin) {
      return res.status(403).json({ success: false, code: "ORIGIN_FORBIDDEN", error: "This request must come from the restaurant site." });
    }
    if (req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ success: false, code: "ORIGIN_FORBIDDEN", error: "Cross-site API requests are not allowed." });
    next();
  });
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, code: "RATE_LIMITED", error: "Too many requests. Please wait a minute and try again." } }));
  app.use("/__/auth", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use("/api/chapa/initialize", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, code: "CHECKOUT_RATE_LIMITED", error: "Please wait a minute before starting another checkout.", retryAction: "wait" } }));
  app.use("/api/database/events", createStreamLimiter());
}

export function createStreamLimiter(maxTotal = 250, maxPerIp = 40, lifetimeMs = 5 * 60_000): RequestHandler {
  let total = 0;
  const connections = new Map<string, number>();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const count = connections.get(key) || 0;
    if (total >= maxTotal || count >= maxPerIp) return res.status(429).json({ code: "SSE_CONNECTION_LIMIT", error: "Too many live connections. Please retry shortly." });
    total++;
    connections.set(key, count + 1);
    const expiry = setTimeout(() => res.end(), lifetimeMs);
    expiry.unref();
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      clearTimeout(expiry);
      total--;
      const remaining = (connections.get(key) || 1) - 1;
      if (remaining) connections.set(key, remaining); else connections.delete(key);
    };
    res.once("close", release);
    res.once("finish", release);
    next();
  };
}

/** Applied after customer authentication, so changing IPs cannot evade it. */
export function authenticatedOrderLimit(): RequestHandler {
  return rateLimit({
    windowMs: 10 * 60_000, limit: 30,
    keyGenerator: (_req, res) => String(res.locals.uid || "unauthenticated"),
    standardHeaders: "draft-8", legacyHeaders: false,
    message: { success: false, code: "CHECKOUT_RATE_LIMITED", error: "Too many checkout requests. Please wait before trying again.", retryAction: "wait" },
  });
}

export const validateJsonShape: RequestHandler = (req, res, next) => {
  if (!req.path.startsWith("/api/") || req.body === undefined) return next();
  let remaining = 50_000;
  function safe(value: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 24) return false;
    if (Array.isArray(value)) return value.length <= 10_000 && value.every(item => safe(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.entries(value).every(([key, item]) => key.length > 0 && key.length <= 300 && !/[\u0000-\u001f]/.test(key) && !key.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part)) && safe(item, depth + 1));
    }
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || !safe(req.body, 0)) {
    return res.status(400).json({ success: false, code: "INVALID_REQUEST_BODY", error: "The request contains invalid or excessive data." });
  }
  next();
};

export const safeApiError: ErrorRequestHandler = (error, req, res, next) => {
  if (!req.path.startsWith("/api/") && !req.path.startsWith("/__/auth/")) return next(error);
  if (res.headersSent || res.destroyed || req.aborted) return;
  const status = error?.type === "entity.too.large" ? 413 : ["entity.parse.failed", "request.aborted"].includes(error?.type) ? 400 : error?.type === "encoding.unsupported" ? 415 : 500;
  res.status(status).json({ success: false, code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 415 ? "UNSUPPORTED_ENCODING" : status === 400 ? "INVALID_REQUEST_BODY" : "INTERNAL_ERROR", error: status === 500 ? "The request could not be completed." : "The request body is invalid or too large." });
};
