import type { Review, Reservation, UserProfile } from '../types';

/** Legacy rows are untrusted even after stricter server validation is deployed. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, fallback = '', maxLength = 4000): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, 200).map(entry => entry.slice(0, 1000)) : [];
}
function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizeUserProfile(value: unknown, uid?: string): UserProfile {
  const row = record(value);
  return {
    uid: uid ?? text(row.uid, '', 128),
    email: text(row.email, '', 254),
    displayName: text(row.displayName, 'Customer', 200),
    savedAddresses: stringList(row.savedAddresses),
    favoriteItems: stringList(row.favoriteItems),
    createdAt: text(row.createdAt, '', 64)
  };
}

export function normalizeReview(value: unknown, id: string): Review {
  const row = record(value);
  return {
    id,
    menuItemId: text(row.menuItemId, '', 128),
    userId: text(row.userId, '', 128),
    customerName: text(row.customerName, 'Customer', 200),
    rating: Math.round(boundedNumber(row.rating, 0, 0, 5)),
    comment: text(row.comment),
    createdAt: text(row.createdAt, '', 64)
  };
}

export function normalizeReservation(value: unknown, id: string): Reservation {
  const row = record(value);
  return {
    id,
    customerName: text(row.customerName, 'Customer', 200),
    customerEmail: text(row.customerEmail, '', 254),
    customerPhone: text(row.customerPhone, '', 32),
    date: text(row.date, '', 32),
    time: text(row.time, '', 32),
    partySize: Math.round(boundedNumber(row.partySize, 1, 1, 100)),
    status: row.status === 'confirmed' || row.status === 'cancelled' ? row.status : 'pending',
    notes: text(row.notes),
    userId: text(row.userId, '', 128),
    createdAt: text(row.createdAt, '', 64)
  };
}
