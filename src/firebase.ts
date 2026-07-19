import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  projectId: "checkers-c95a7",
  appId: "1:527536203559:web:85d76ae0f19d306f9c6b02",
  apiKey: "AIzaSyBFJ4RLrnFvgIL4cx1mXoP9CByc5NAhWno",
  authDomain: "checkers-c95a7.firebaseapp.com",
  storageBucket: "checkers-c95a7.firebasestorage.app",
  messagingSenderId: "527536203559",
  measurementId: ""
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, "ai-studio-restaurantwebsit-315fb01e-8f08-42d3-b0aa-03636feabfef");
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export { signInWithPopup, signOut, onAuthStateChanged };
