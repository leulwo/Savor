import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';

const env = (import.meta as any).env || {};
const procEnv = typeof process !== 'undefined' ? process.env : {};

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || procEnv.VITE_FIREBASE_API_KEY || '',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || procEnv.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: env.VITE_FIREBASE_PROJECT_ID || procEnv.VITE_FIREBASE_PROJECT_ID || procEnv.FIREBASE_PROJECT_ID || '',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || procEnv.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || procEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: env.VITE_FIREBASE_APP_ID || procEnv.VITE_FIREBASE_APP_ID || '',
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || procEnv.VITE_FIREBASE_MEASUREMENT_ID || ''
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app); // Just use getFirestore(app) now!
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

/**
 * fetch() wrapper that attaches the current user's Firebase ID token as
 * `Authorization: Bearer <idToken>` when a user is signed in. Public routes keep
 * working unchanged (no token is hard-required); protected /api/* routes are
 * authenticated automatically for signed-in (admin/staff/customer) sessions.
 */
export async function authedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers || {});
  try {
    const user = auth.currentUser;
    if (user) {
      const idToken = await user.getIdToken();
      headers.set("Authorization", `Bearer ${idToken}`);
    }
  } catch (e) {
    console.warn("[authedFetch] Unable to attach Firebase ID token; proceeding without Authorization header.", e);
  }
  return fetch(url, { ...options, headers });
}

export { signInWithPopup, signOut, onAuthStateChanged };
