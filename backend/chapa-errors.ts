export type RetryAction = "wait" | "same_reference" | "new_reference";

export function normalizeChapaMessage(value: any, depth = 0): string {
  let visited = 0;
  const seen = new WeakSet<object>();
  const normalize = (item: any, currentDepth: number): string => {
    if (currentDepth > 5 || item == null || ++visited > 256) return "";
    if (typeof item === "string") return item.trim().slice(0, 4096);
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    if (typeof item !== "object" || seen.has(item)) return "";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 40).map(child => normalize(child, currentDepth + 1)).filter(Boolean).join("; ").slice(0, 4096);
    const preferred = ["message", "error", "details", "errors", "description", "reason"];
    const parts = preferred.filter(key => Object.hasOwn(item, key)).map(key => normalize(item[key], currentDepth + 1)).filter(Boolean);
    if (parts.length) return Array.from(new Set(parts)).join("; ").slice(0, 4096);
    return Object.entries(item).slice(0, 40).map(([key, child]) => {
      const message = normalize(child, currentDepth + 1);
      return message ? `${key.slice(0, 100)}: ${message}` : "";
    }).filter(Boolean).join("; ").slice(0, 4096);
  };
  return normalize(value, depth);
}

/** A development-log-only provider hint. Never send this diagnostic to clients. */
export function safeChapaDiagnostic(body: any, redactValues: unknown[] = []): string {
  let text = normalizeChapaMessage(body);
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const value of redactValues.map(item => String(item || "")).filter(item => item.length >= 3).sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escaped(value), "gi"), "[redacted]");
  }
  text = text
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bCHASECK(?:_[A-Z]+)?-[A-Za-z0-9_-]+\b/gi, "[credential]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(?:\+?251|0)[79]\d[\s()-]?\d{3}[\s()-]?\d{4}\b/g, "[phone]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\bPAY-[A-Za-z0-9_-]+\b/gi, "[reference]")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 220) || "(provider returned no readable message)";
}

export function mapChapaFailure(status: number, body: any): { code: string; message: string; retryAction: RetryAction; reasonClass: string } {
  const text = normalizeChapaMessage(body).toLowerCase();
  if (status === 401 || /unauthori[sz]ed|invalid.*(secret|api key)|api key.*invalid|mode.*mismatch/.test(text))
    return { code: "CHAPA_AUTH_REJECTED", message: "Chapa rejected the configured secret key. Check that the server key matches the selected Test or Live mode.", retryAction: "wait", reasonClass: "authorization" };
  if (status === 404 || /api.*disabled|endpoint.*disabled/.test(text))
    return { code: "CHAPA_API_DISABLED", message: "Chapa payments are not enabled for this account yet.", retryAction: "wait", reasonClass: "api_disabled" };
  if (/user.*(?:can't|can.t|cannot).*receive payments?|cannot receive payments?/.test(text))
    return { code: "CHAPA_ACCOUNT_NOT_READY", message: "This Chapa account cannot receive payments yet. Contact Chapa support to enable payment acceptance.", retryAction: "wait", reasonClass: "merchant_account" };
  if (/incorrect header settings|content-type.*application\/json/.test(text))
    return { code: "CHAPA_REQUEST_FORMAT_INVALID", message: "The payment request could not be sent in Chapa's expected format. Please retry, and contact support if it continues.", retryAction: "same_reference", reasonClass: "request_format" };
  if (/customization\.(?:title|description)|customization.*only contain/.test(text))
    return { code: "CHAPA_INVALID_CUSTOMIZATION", message: "The payment page could not be prepared. Please contact support before retrying.", retryAction: "wait", reasonClass: "customization" };
  if (/duplicate|already exists|tx_ref.*exists|reference.*used/.test(text))
    return { code: "CHAPA_DUPLICATE_REFERENCE", message: "This payment reference already exists. We’re checking its outcome before starting another payment.", retryAction: "wait", reasonClass: "duplicate_reference" };
  if (status === 408 || status === 429) return { code: "CHAPA_UNAVAILABLE", message: "Chapa is temporarily busy. We’re checking your saved payment request; try again shortly.", retryAction: "wait", reasonClass: "provider_unavailable" };
  if (/phone/.test(text)) return { code: "CHAPA_INVALID_PHONE", message: "Check the phone number and try again.", retryAction: "new_reference", reasonClass: "phone" };
  if (/amount.*(?:must be a number|must be numeric|numeric value)|amount field.*number/.test(text))
    return { code: "CHAPA_INVALID_AMOUNT", message: "The payment amount could not be validated. Refresh the order total and try again.", retryAction: "new_reference", reasonClass: "amount_type" };
  if (/amount.*(?:maximum limit|exceed.*maximum)|amount must not exceed/.test(text))
    return { code: "CHAPA_INVALID_AMOUNT", message: "This order total is outside Chapa's accepted amount range.", retryAction: "new_reference", reasonClass: "amount_limit" };
  if (/currency.*(?:not supported|unsupported)|unsupported currency/.test(text))
    return { code: "CHAPA_INVALID_CURRENCY", message: "This payment currency is not supported by Chapa. Contact support if this keeps happening.", retryAction: "wait", reasonClass: "currency" };
  if (/subaccount.*(?:not associated|invalid)|subaccount id/.test(text))
    return { code: "CHAPA_SUBACCOUNT_INVALID", message: "The merchant payment account is not configured correctly. Contact support before retrying.", retryAction: "wait", reasonClass: "subaccount" };
  if (/merchant.*(?:share|fee)|transaction fee.*merchant/.test(text))
    return { code: "CHAPA_MERCHANT_FEE_INVALID", message: "The merchant payment settings need attention. Contact support before retrying.", retryAction: "wait", reasonClass: "merchant_fee" };
  if (/validation|required|invalid.*(amount|email|currency|field)|missing|no more than \d+ characters|must be no more than \d+ characters|email.*valid email|email.*valid format|first name.*(?:length|characters)|last name.*(?:length|characters)/.test(text))
    return { code: "CHAPA_INVALID_FIELDS", message: "Some payment details were rejected. Review your checkout details and try again.", retryAction: "new_reference", reasonClass: "required_fields" };
  if (status >= 500) return { code: "CHAPA_UNAVAILABLE", message: "Chapa is temporarily unavailable. Your payment request is saved; try again shortly.", retryAction: "same_reference", reasonClass: "provider_unavailable" };
  return { code: status === 400 ? "CHAPA_REQUEST_REJECTED" : "CHAPA_INITIALIZE_REJECTED", message: status === 400 ? "Chapa rejected this payment request. Check the checkout details and merchant payment settings, then try again." : "Chapa could not start checkout. Review your payment details and try again.", retryAction: "new_reference", reasonClass: status === 400 ? "unclassified_400" : "unclassified" };
}
