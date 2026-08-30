/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export function parseHHMMToMinutes(value: string | undefined | null): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!m) return null;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return mins >= 0 && mins < 1440 ? mins : null;
}

// Orders are accepted between openTime and (closeTime - prepTimeMinutes) so
// the kitchen can finish preparing existing orders before closing.
export function scheduleAccepts(s: { scheduleEnabled?: boolean; openTime?: string; closeTime?: string; prepTimeMinutes?: number; isOpen?: boolean }, now: Date = new Date()):
  { accepting: boolean; reason?: "notOpen" | "stopOrders" } {
  if (!s) return { accepting: true };
  if (!s.scheduleEnabled) return { accepting: !!s.isOpen };
  const open = parseHHMMToMinutes(s.openTime);
  const close = parseHHMMToMinutes(s.closeTime);
  if (open === null || close === null) return { accepting: !!s.isOpen };
  const prep = Math.max(0, Number(s.prepTimeMinutes) || 30);
  const cutoff = Math.min(1440, close - prep);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (open < close) {
    if (nowMin >= open && nowMin < cutoff) return { accepting: true };
    return { accepting: false, reason: nowMin < open ? "notOpen" : "stopOrders" };
  }
  // Overnight schedule (e.g. 18:00 → 02:00).
  if (nowMin >= open || nowMin < cutoff) return { accepting: true };
  return { accepting: false, reason: nowMin >= cutoff ? "stopOrders" : "notOpen" };
}

export function formatTimeHHMM(value: string | undefined | null): string {
  const mins = parseHHMMToMinutes(value);
  if (mins === null) return "";
  const hours24 = Math.floor(mins / 60);
  const minutes = mins % 60;
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return minutes === 0 ? `${hours12} ${period}` : `${hours12}:${String(minutes).padStart(2, "0")} ${period}`;
}