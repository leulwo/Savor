import { requireApiPath } from './security';

type ApiUser = { uid: string; getIdToken(forceRefresh?: boolean): Promise<string> };
type ApiAuth = { currentUser: ApiUser | null; authStateReady(): Promise<void> };

/** A single token refresh is allowed; account changes and HTTP redirects fail closed. */
export function createAuthenticatedFetch(auth: ApiAuth, fetchRequest: typeof fetch = fetch) {
  return async (value: string, options: RequestInit = {}): Promise<Response> => {
    const url = requireApiPath(value);
    await auth.authStateReady();
    const user = auth.currentUser;
    const uid = user?.uid ?? null;
    const ensureCurrentUser = () => {
      if ((auth.currentUser?.uid ?? null) !== uid) {
        throw Object.assign(new Error('Your sign-in session changed. Please try again.'), { code: 'AUTH_USER_CHANGED' });
      }
    };
    const headers = new Headers(options.headers);
    // Never reuse an Authorization header supplied by a caller or a previous account.
    headers.delete('Authorization');
    const attachToken = async (refresh = false) => {
      if (!user) return;
      let token: string;
      try { token = await user.getIdToken(refresh); }
      catch {
        throw Object.assign(new Error('Your sign-in session expired. Sign in again to continue.'), { code: 'AUTH_SESSION_EXPIRED' });
      }
      ensureCurrentUser();
      headers.set('Authorization', `Bearer ${token}`);
    };
    await attachToken();
    ensureCurrentUser();
    const send = () => fetchRequest(url, { ...options, headers, redirect: 'error', credentials: 'same-origin', cache: 'no-store' });
    let response = await send();
    ensureCurrentUser();
    if (response.status === 401 && user) {
      await attachToken(true);
      response = await send();
      ensureCurrentUser();
    }
    return response;
  };
}
