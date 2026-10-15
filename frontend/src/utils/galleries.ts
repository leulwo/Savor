/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Data URLs contain a literal comma (e.g. "data:image/jpeg;base64,XXXX"),
// so a naive split on "," corrupts image lists. This parser splits only on
// commas that precede the start of a real URL, and reattaches orphan base64
// chunks left behind by earlier comma-broken saves.
export function splitGalleryImages(s: string): string[] {
  if (!s) return [];
  const parts = s.split(/,\s*(?=data:image\/|data:audio\/|data:video\/|https?:\/\/)/);
  const out: string[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith("data:") || t.startsWith("http")) {
      out.push(t);
    } else if (out.length > 0) {
      out[out.length - 1] += "," + t;
    } else {
      out.push(t);
    }
  }
  return out;
}

export function normalizeGalleryImages(list?: string[] | string | null): string[] {
  if (Array.isArray(list)) return splitGalleryImages(list.join(", "));
  return splitGalleryImages(list || "");
}