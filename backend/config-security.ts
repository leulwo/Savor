const privateKey = /(?:secret|password|credential|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|webhook[_-]?token)/i;

/** Legacy integration credentials are never part of a browser-readable export. */
export function redactServerSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(redactServerSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateKey.test(key))
    .map(([key, item]) => [key, redactServerSecrets(item)]));
}

export function safeAuthRedirect(value: string, upstreamOrigin: string, appOrigin: string): string | null {
  try {
    const target = new URL(value, upstreamOrigin);
    if (target.protocol !== "https:" || target.username || target.password || /[\u0000-\u0020\\]/.test(value)) return null;
    if (target.origin === upstreamOrigin) return `${appOrigin}${target.pathname}${target.search}${target.hash}`;
    return target.origin === "https://accounts.google.com" ? target.href : null;
  } catch { return null; }
}

export function mergeFirebaseConfiguration(file: Record<string, any>, environment: Record<string, any>): Record<string, any> {
  return { ...file, ...Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined && value !== "")) };
}

export function validatedCheckoutSettings(body: unknown): Record<string, string | number | boolean> {
  const invalid = () => { throw Object.assign(new Error("Review the checkout settings and try again."), { statusCode: 400 }); };
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
  const numeric: Record<string, [number, number, boolean]> = {
    serviceTaxPercent: [0, 100, false], flatFeeETB: [0, 100000, false],
    shipdayDeliveryMinutes: [1, 240, true], shipdayPickupMinutes: [1, 240, true],
    prepTimeMinutes: [1, 1440, true], scheduledStepsMinutes: [1, 1440, true],
  };
  const booleans = new Set(["enableCOD", "isOpen", "scheduleEnabled", "enableMarketing", "enableReservations", "enableChatbot"]);
  const times = new Set(["openTime", "closeTime"]);
  const settings: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(numeric, key)) {
      if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) return invalid();
      const number = Number(value);
      const [min, max, integer] = numeric[key];
      if (!Number.isFinite(number) || number < min || number > max || integer && !Number.isInteger(number)) return invalid();
      settings[key] = number;
    } else if (booleans.has(key)) {
      if (typeof value !== "boolean") return invalid();
      settings[key] = value;
    } else if (times.has(key)) {
      if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return invalid();
      settings[key] = value;
    } else return invalid();
  }
  return settings;
}

export function normalizeSettingsFields(data: Record<string, any>): Record<string, any> {
  const logical = new Set(["serviceTaxPercent", "flatFeeETB", "shipdayDeliveryMinutes", "shipdayPickupMinutes", "prepTimeMinutes", "scheduledStepsMinutes", "enableCOD", "isOpen", "scheduleEnabled", "enableMarketing", "enableReservations", "enableChatbot", "openTime", "closeTime"]);
  const textLimits = { restaurantName: 200, businessEmail: 320, businessPhone: 100, businessAddress: 3000 };
  const primitiveFields = new Set([...logical, ...Object.keys(textLimits)]);
  const selected: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    // Dotted updates replace a primitive parent with an object in LocalStore.
    // Check every validated scalar, including the publicly rendered business text.
    if (key.includes(".") && primitiveFields.has(key.split(".")[0])) throw Object.assign(new Error("Invalid checkout setting field."), { status: 400, statusCode: 400, code: "DATABASE_INVALID_REQUEST" });
    if (logical.has(key)) selected[key] = value;
  }
  for (const [key, maximum] of Object.entries(textLimits)) {
    if (data[key] !== undefined && (typeof data[key] !== "string" || data[key].length > maximum)) throw Object.assign(new Error("Invalid business setting."), { status: 400, statusCode: 400, code: "DATABASE_INVALID_REQUEST" });
  }
  try { return { ...data, ...validatedCheckoutSettings(selected) }; }
  catch (error: any) { error.status = error.statusCode || 400; error.code = "DATABASE_INVALID_REQUEST"; throw error; }
}
