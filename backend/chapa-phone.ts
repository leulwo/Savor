/** Chapa hosted checkout accepts an optional Ethiopian mobile in local form. */
export const CHECKOUT_PHONE_ERROR =
  "Enter an Ethiopian mobile number starting with 09 or 07, or use +251 followed by 9 or 7 and eight digits.";

function invalidPhone(): never {
  throw Object.assign(new Error(CHECKOUT_PHONE_ERROR), {
    statusCode: 400,
    code: "CHECKOUT_INVALID_PHONE"
  });
}

/**
 * Accept familiar mobile dialling formats and return Chapa's 10-digit form.
 * Strip presentation characters only; letters, extensions and other countries
 * are rejected instead of silently turning an unrelated string into a phone.
 */
export function chapaPhoneNumber(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 80) return invalidPhone();

  const input = value
    .replace(/[\u0660-\u0669\u06f0-\u06f9\uff10-\uff19]/g, character => {
      const point = character.charCodeAt(0);
      const start = point >= 0xff10 ? 0xff10 : point >= 0x06f0 ? 0x06f0 : 0x0660;
      return String(point - start);
    })
    .replace(/\uff0b/g, "+")
    .replace(/[\u2010-\u2014\uff0d]/g, "-")
    .replace(/\uff08/g, "(")
    .replace(/\uff09/g, ")")
    .replace(/\uff0e/g, ".")
    .replace(/[\u200b\u200e\u200f\u2066-\u2069\ufeff]/g, "")
    .trim();
  if (!input) return undefined;
  if (!/^[+0-9\s().-]+$/.test(input)) return invalidPhone();
  // A country/area grouping may use parentheses, but never unmatched/nested ones.
  let groupOpen = false;
  for (const character of input) {
    if (character === "(") {
      if (groupOpen) return invalidPhone();
      groupOpen = true;
    } else if (character === ")") {
      if (!groupOpen) return invalidPhone();
      groupOpen = false;
    }
  }
  if (groupOpen || /\([\s.-]*\)/.test(input)) return invalidPhone();

  const compact = input.replace(/[\s().-]/g, "");
  if (/^0[79]\d{8}$/.test(compact)) return compact;
  if (/^[79]\d{8}$/.test(compact)) return "0" + compact;
  if (/^\+251[79]\d{8}$/.test(compact)) return "0" + compact.slice(4);
  if (/^251[79]\d{8}$/.test(compact)) return "0" + compact.slice(3);
  if (/^00251[79]\d{8}$/.test(compact)) return "0" + compact.slice(5);
  return invalidPhone();
}
