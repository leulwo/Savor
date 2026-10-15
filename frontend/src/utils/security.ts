/** URLs used as navigation targets must never execute script or leak credentials. */
export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function safeChapaCheckoutUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  const href = safeHttpsUrl(value);
  if (!href) return undefined;
  const url = new URL(href);
  return url.hostname === 'checkout.chapa.co' && !url.hash &&
    /^\/checkout\/(?:payment|test-payment)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ? href : undefined;
}

export function safeChapaReceiptUrl(value: unknown): string | undefined {
  const href = safeHttpsUrl(value);
  return href && new URL(href).hostname === 'chapa.link' ? href : undefined;
}

/** Keep Firebase bearer tokens within the application's own API routes. */
export function requireApiPath(value: string): string {
  if (typeof value !== 'string' || !value.startsWith('/api/') || /[\u0000-\u0020\u007f\\#]/.test(value)) {
    throw Object.assign(new Error('Authenticated requests must use this website’s API.'), { code: 'UNSAFE_API_URL' });
  }
  const url = new URL(value, 'https://application.invalid');
  if (url.origin !== 'https://application.invalid' || !url.pathname.startsWith('/api/')) {
    throw Object.assign(new Error('Authenticated requests must use this website’s API.'), { code: 'UNSAFE_API_URL' });
  }
  return `${url.pathname}${url.search}`;
}
