// auth.js - OTP Phone Login
import { auth, db } from "./firebase-config.js";
import {
  RecaptchaVerifier,
  signInWithPhoneNumber
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let confirmationResult = null;
let resendTimer = null;
let currentStep = 0;

// Check if already logged in
const savedMobile = localStorage.getItem("rg_mobile");
const savedName = localStorage.getItem("rg_name");
if (savedMobile && savedName && auth.currentUser) {
  window.location.href = "app.html";
}

// Setup reCAPTCHA
function setupRecaptcha() {
  if (!window.recaptchaVerifier) {
    window.recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", {
      size: "invisible",
      callback: () => {}
    });
  }
}

// Step navigation
function showStep(n) {
  document.querySelectorAll(".step").forEach(s => {
    s.classList.add("hidden");
    s.classList.remove("active");
  });
  const steps = ["step-phone", "step-name", "step-otp"];
  const el = document.getElementById(steps[n]);
  el.classList.remove("hidden");
  el.classList.add("active");
  currentStep = n;
}

window.goBack = function(to) { showStep(to); };

window.goToOtp = function() {
  const name = document.getElementById("name-input").value.trim();
  if (!name) return showError("Enter your name");
  sendOtpToServer();
};

// Send OTP
window.sendOtp = async function() {
  const phone = document.getElementById("phone-input").value.trim();
  if (phone.length < 9) return showError("Enter a valid phone number");
  showStep(1); // go to name step first
};

async function sendOtpToServer() {
  const name = document.getElementById("name-input").value.trim();
  const code = document.getElementById("country-code").value;
  const phone = document.getElementById("phone-input").value.trim();
  const fullPhone = code + phone;
  const mobile = fullPhone.replace("+", "").replace(/\s/g, "");

  setLoading("send-otp-text", "send-otp-loader", true);

  // BYPASS FIREBASE AUTH - Just login directly for testing
  try {
    const uid = "user_" + mobile;
    const userRef = doc(db, "chat_users", mobile);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: uid,
        name: name,
        mobile: mobile,
        avatarUrl: "",
        lastActive: Date.now(),
        typingTo: null,
        statusVisible: true,
        about: "Hey there! I am using RasGram.",
        fcmToken: ""
      });
    } else {
      await updateDoc(userRef, { lastActive: Date.now(), uid: uid });
    }

    const savedName = snap.exists() ? (snap.data().name || name) : name;

    // Save locally
    localStorage.setItem("rg_mobile", mobile);
    localStorage.setItem("rg_name", savedName);
    localStorage.setItem("rg_avatar", snap.exists() ? (snap.data().avatarUrl || "") : "");

    window.location.href = "app.html";
  } catch (e) {
    console.error(e);
    showError("Login failed: " + e.message);
  } finally {
    setLoading("send-otp-text", "send-otp-loader", false);
  }
}

// Verify OTP
window.verifyOtp = async function() {
  const otp = Array.from(document.querySelectorAll(".otp-box")).map(b => b.value).join("");
  if (otp.length !== 6) return showOtpError("Enter 6-digit OTP");

  setLoading("verify-text", "verify-loader", true);
  hideOtpError();

  try {
    const result = await confirmationResult.confirm(otp);
    const user = result.user;
    const code = document.getElementById("country-code").value;
    const phone = document.getElementById("phone-input").value.trim();
    const mobile = (code + phone).replace("+", "").replace(/\s/g, "");
    const name = document.getElementById("name-input").value.trim();

    // Save to Firestore (same collection as Android app)
    const userRef = doc(db, "chat_users", mobile);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        name,
        mobile,
        avatarUrl: "",
        lastActive: Date.now(),
        typingTo: null,
        statusVisible: true,
        about: "Hey there! I am using RasGram.",
        fcmToken: ""
      });
    } else {
      await updateDoc(userRef, { lastActive: Date.now(), uid: user.uid });
    }

    const savedName = snap.exists() ? (snap.data().name || name) : name;

    // Save locally
    localStorage.setItem("rg_mobile", mobile);
    localStorage.setItem("rg_name", savedName);
    localStorage.setItem("rg_avatar", snap.exists() ? (snap.data().avatarUrl || "") : "");

    window.location.href = "app.html";
  } catch (e) {
    console.error(e);
    showOtpError("Invalid OTP. Please try again.");
  } finally {
    setLoading("verify-text", "verify-loader", false);
  }
};

// Resend OTP
window.resendOtp = function() {
  showStep(1);
  setTimeout(() => sendOtpToServer(), 100);
};

// OTP box navigation
window.otpInput = function(el, idx) {
  el.classList.toggle("filled", el.value !== "");
  if (el.value && idx < 5) {
    document.querySelectorAll(".otp-box")[idx + 1].focus();
  }
  // Auto verify when all filled
  const otp = Array.from(document.querySelectorAll(".otp-box")).map(b => b.value).join("");
  if (otp.length === 6) window.verifyOtp();
};

window.otpKey = function(el, e, idx) {
  if (e.key === "Backspace" && !el.value && idx > 0) {
    document.querySelectorAll(".otp-box")[idx - 1].focus();
  }
};

// Countdown timer
function startCountdown() {
  clearInterval(resendTimer);
  let count = 60;
  const countEl = document.getElementById("resend-countdown");
  const resendEl = document.getElementById("resend-link");
  countEl.classList.remove("hidden");
  resendEl.classList.add("hidden");

  resendTimer = setInterval(() => {
    count--;
    countEl.textContent = count + "s";
    if (count <= 0) {
      clearInterval(resendTimer);
      countEl.classList.add("hidden");
      resendEl.classList.remove("hidden");
    }
  }, 1000);
}

// Helpers
function setLoading(textId, loaderId, loading) {
  document.getElementById(textId).classList.toggle("hidden", loading);
  document.getElementById(loaderId).classList.toggle("hidden", !loading);
}

function showError(msg) { alert(msg); }
function showOtpError(msg) {
  const el = document.getElementById("otp-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideOtpError() { document.getElementById("otp-error").classList.add("hidden"); }
