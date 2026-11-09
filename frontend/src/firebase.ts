import { initializeApp } from 'firebase/app';
import { createDatabaseClient } from './database';
import { createAuthenticatedFetch } from './utils/authenticatedFetch';
import { clearPrivateBrowserCache } from './utils/privateCache';
import {
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut as firebaseSignOut
} from 'firebase/auth';

const env = (import.meta as any).env || {};
const procEnv = typeof process !== 'undefined' ? process.env : {};
const configuredAuthDomain = env.VITE_FIREBASE_AUTH_DOMAIN || procEnv.VITE_FIREBASE_AUTH_DOMAIN || '';

// When running on a custom domain (e.g. freshmen.me), use the current host so Google Sign-In
// popups reflect your branded domain instead of the generic *.firebaseapp.com URL.
// The backend server transparently reverse-proxies /__/auth/** to Firebase Auth.
const isCustomDomain = typeof window !== 'undefined'
  && window.location.hostname !== 'localhost'
  && window.location.hostname !== '127.0.0.1'
  && !window.location.hostname.endsWith('.firebaseapp.com')
  && !window.location.hostname.endsWith('.web.app');

const activeAuthDomain = isCustomDomain
  ? window.location.host
  : (configuredAuthDomain || 'project-609a1e43-d22e-44ae-a08.firebaseapp.com');

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || procEnv.VITE_FIREBASE_API_KEY || '',
  authDomain: activeAuthDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID || procEnv.VITE_FIREBASE_PROJECT_ID || procEnv.FIREBASE_PROJECT_ID || '',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || procEnv.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || procEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: env.VITE_FIREBASE_APP_ID || procEnv.VITE_FIREBASE_APP_ID || '',
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || procEnv.VITE_FIREBASE_MEASUREMENT_ID || ''
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = createDatabaseClient(auth);
export const googleProvider = new GoogleAuthProvider();
const GOOGLE_REDIRECT_PENDING_KEY = 'savory_google_redirect_pending';
const authPersistenceReady = setPersistence(auth, browserLocalPersistence);

export function hasPendingGoogleRedirect(): boolean {
  return typeof window !== 'undefined'
    && window.sessionStorage.getItem(GOOGLE_REDIRECT_PENDING_KEY) === '1';
}

export async function signInWithGoogle(): Promise<void> {
  await authPersistenceReady;
  // Popup auth keeps Google's callback on the stable Firebase auth domain.
  // Temporary Cloudflare Tunnel hostnames can therefore change without an
  // OAuth redirect URI update for every new tunnel.
  await signInWithPopup(auth, googleProvider);
}

export async function completeGoogleSignIn() {
  await authPersistenceReady;
  try {
    return await getRedirectResult(auth);
  } finally {
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(GOOGLE_REDIRECT_PENDING_KEY);
    }
  }
}

export function googleSignInErrorMessage(error: any): string {
  const code = String(error?.code || '');
  if (code === 'auth/network-request-failed') {
    return 'Google sign-in could not connect. Check your connection and try again.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'This website address is not authorized for Google sign-in. Add it in Firebase Authentication settings.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Google sign-in is not enabled in Firebase Authentication.';
  }
  if (code === 'auth/web-storage-unsupported') {
    return 'This browser is blocking the storage needed to keep you signed in.';
  }
  return typeof error?.message === 'string' && error.message.trim()
    ? error.message
    : 'Google sign-in could not be completed. Please try again.';
}

/**
 * fetch() wrapper that attaches the current user's Firebase ID token as
 * `Authorization: Bearer <idToken>` when a user is signed in. Public routes keep
 * working unchanged (no token is hard-required); protected /api/* routes are
 * authenticated automatically for signed-in (admin/staff/customer) sessions.
 */
export const authedFetch = createAuthenticatedFetch(auth);

export async function signOut(authInstance: Parameters<typeof firebaseSignOut>[0]): Promise<void> {
  await firebaseSignOut(authInstance);
  if (typeof window !== 'undefined') clearPrivateBrowserCache(window.localStorage);
}

export { onAuthStateChanged };
