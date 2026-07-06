// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDS7zJTWsOyx4xDswLOPk3uf_jcnjYRWVk",
  authDomain: "mywebtools-f8d53.firebaseapp.com",
  projectId: "mywebtools-f8d53",
  storageBucket: "mywebtools-f8d53.firebasestorage.app",
  messagingSenderId: "979594414301",
  appId: "1:979594414301:android:aac512b6055e05a685f334"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
