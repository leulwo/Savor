/** Shared-device sign-out must not expose the previous customer's details. */
export const PRIVATE_CACHE_KEYS = [
  'lastAuthUid', 'lastCheckoutName', 'lastCheckoutEmail', 'lastCheckoutPhone',
  'lastCheckoutBlock', 'lastCheckoutRoom', 'lastCheckoutAddress',
  'lastCheckoutUseGoogleMaps', 'lastCheckoutSpecialInstructions',
  'gourmet_cart', 'gourmet_cart_backup', 'gourmet_cart_cleared_order', 'gourmet_cart_cleared_at',
  'activeOrderId', 'shownOrderModalId', 'chapaCheckoutUrl', 'chapaClientRequestId',
  'cashOrderClientRequestId', 'chapaReconciliationOrderId',
  'savory_notifications_cache_v2', 'savory_customer_name', 'savory_conversation_id',
  'customer_last_seen_chat_time', 'admin_chat_read_counts', 'admin_last_seen_chat_time',
  'newsletterAgreed'
] as const;

export function clearPrivateBrowserCache(storage: Pick<Storage, 'removeItem' | 'length' | 'key'>): void {
  // Include namespaced notification caches so sign-out removes locally cached order history.
  const keys: string[] = [...PRIVATE_CACHE_KEYS];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith('savory_notifications_cache_v3:')) keys.push(key);
  }
  keys.forEach(key => storage.removeItem(key));
}

export function notificationCacheKey(uid: string | null | undefined): string | null {
  return uid ? `savory_notifications_cache_v3:${encodeURIComponent(uid)}` : null;
}
