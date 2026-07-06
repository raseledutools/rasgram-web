// chat.js - Main Chat Logic (Real-time Firebase + WebRTC Calls)
import { auth, db } from "./firebase-config.js";
import {
  collection, doc, getDoc, setDoc, updateDoc, addDoc, query,
  orderBy, limit, onSnapshot, where, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// ─── State ────────────────────────────────────────────────────────────────────
let myMobile = localStorage.getItem("rg_mobile") || "";
let myName   = localStorage.getItem("rg_name") || "";
let myAvatar = localStorage.getItem("rg_avatar") || "";

let allUsers = [];
let activeContact = null;
let messagesUnsub = null;
let typingTimeout = null;
let isSearchOpen = false;
let isMuted = false;
let isSpeakerOn = false;

// WebRTC
let peerConnection = null;
let localStream = null;
let callId = null;
let callUnsub = null;
let currentCallType = "audio";

const CLOUDINARY_URL = "https://api.cloudinary.com/v1_1/de2w78yxh/auto/upload";
const CLOUDINARY_PRESET = "ml_default";

// ─── Auth Guard ───────────────────────────────────────────────────────────────
if (!myMobile) { window.location.href = "index.html"; }

// ─── Init ─────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  initApp();
});

function initApp() {
  renderMyAvatar();
  loadContacts();
  setOnline();
  setInterval(setOnline, 30000);
}

function setOnline() {
  if (!myMobile) return;
  updateDoc(doc(db, "chat_users", myMobile), { lastActive: Date.now() }).catch(() => {});
}

// ─── Avatar render ────────────────────────────────────────────────────────────
function renderMyAvatar() {
  const el = document.getElementById("my-avatar");
  if (myAvatar) {
    el.innerHTML = `<img src="${myAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />`;
  } else {
    el.textContent = myName.charAt(0).toUpperCase();
    el.style.background = "linear-gradient(135deg,#00A884,#008069)";
  }
}

// ─── Load Contacts ────────────────────────────────────────────────────────────
function loadContacts() {
  onSnapshot(collection(db, "chat_users"), (snapshot) => {
    allUsers = snapshot.docs
      .map(d => ({ mobile: d.id, ...d.data() }))
      .filter(u => u.mobile !== myMobile);

    loadLatestMessages();
    renderContacts(allUsers);
  });
}

const latestMsgCache = {};
const unreadCache = {};

function loadLatestMessages() {
  allUsers.forEach(user => {
    const chatId = generateChatId(myMobile, user.mobile);
    const msgCol = collection(db, `pvt_msg_${chatId}`);
    const q = query(msgCol, orderBy("timestamp", "desc"), limit(1));
    onSnapshot(q, (snap) => {
      if (!snap.empty) {
        latestMsgCache[user.mobile] = snap.docs[0].data();
      }
      renderContacts(allUsers);
    });
  });
}

function renderContacts(users, filter = "") {
  const list = document.getElementById("contact-list");
  const filtered = users.filter(u =>
    !filter ||
    u.name.toLowerCase().includes(filter.toLowerCase()) ||
    u.mobile.includes(filter)
  ).sort((a, b) => {
    const at = latestMsgCache[a.mobile]?.timestamp || 0;
    const bt = latestMsgCache[b.mobile]?.timestamp || 0;
    return bt - at;
  });

  if (filtered.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted)">No contacts found</div>`;
    return;
  }

  list.innerHTML = filtered.map(u => {
    const isOnline = (Date.now() - (u.lastActive || 0)) < 120000;
    const initials = u.name ? u.name.charAt(0).toUpperCase() : "?";
    const avatarHtml = u.avatarUrl
      ? `<img src="${u.avatarUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />`
      : initials;
    const isTyping = u.typingTo === myMobile;
    const lastMsg = latestMsgCache[u.mobile];
    const preview = isTyping ? "<span style='color:var(--green)'>typing...</span>"
      : lastMsg ? (lastMsg.isDeleted ? "<i>Message deleted</i>" : (lastMsg.fileType ? "📎 " + lastMsg.fileType : lastMsg.text || ""))
      : "<span style='color:var(--muted)'>No messages yet</span>";
    const time = lastMsg ? formatTime(lastMsg.timestamp) : "";
    const isActive = activeContact?.mobile === u.mobile;

    return `
      <div class="contact-item ${isActive ? 'active' : ''}" onclick="openChat('${u.mobile}')" id="contact-${u.mobile}">
        <div class="avatar" style="width:48px;height:48px;font-size:18px;background:linear-gradient(135deg,#00A884,#008069);position:relative">
          ${avatarHtml}
          ${isOnline ? '<div class="online-dot"></div>' : ''}
        </div>
        <div class="contact-info">
          <div class="contact-name">${escHtml(u.name)}</div>
          <div class="contact-preview">${preview}</div>
        </div>
        <div class="contact-meta">
          <span class="contact-time">${time}</span>
        </div>
      </div>
    `;
  }).join("");
}

// ─── Open Chat ────────────────────────────────────────────────────────────────
window.openChat = function(mobile) {
  const user = allUsers.find(u => u.mobile === mobile);
  if (!user) return;
  activeContact = user;

  // Mobile: show right panel
  if (window.innerWidth < 768) {
    document.getElementById("left-panel").classList.add("mobile-hide");
    document.getElementById("right-panel").classList.add("mobile-show");
    document.getElementById("back-btn").style.display = "flex";
  }

  document.getElementById("empty-state").style.display = "none";
  document.getElementById("chat-area").style.display = "flex";

  // Set header
  const initials = user.name ? user.name.charAt(0).toUpperCase() : "?";
  const avatarEl = document.getElementById("chat-avatar");
  avatarEl.style.background = "linear-gradient(135deg,#00A884,#008069)";
  avatarEl.innerHTML = user.avatarUrl
    ? `<img src="${user.avatarUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />`
    : initials;

  document.getElementById("chat-name").textContent = user.name;
  updateContactStatus(user);

  // Re-render contacts to mark active
  renderContacts(allUsers);

  // Load messages
  if (messagesUnsub) messagesUnsub();
  loadMessages(user.mobile);
  markRead(user.mobile);

  // Listen for typing
  listenTyping(user.mobile);
};

window.closeChat = function() {
  document.getElementById("left-panel").classList.remove("mobile-hide");
  document.getElementById("right-panel").classList.remove("mobile-show");
  activeContact = null;
};

function updateContactStatus(user) {
  const isOnline = (Date.now() - (user.lastActive || 0)) < 120000;
  const statusEl = document.getElementById("chat-status");
  if (isOnline) {
    statusEl.textContent = "online";
    statusEl.style.color = "var(--green)";
  } else {
    statusEl.textContent = "last seen " + formatLastSeen(user.lastActive);
    statusEl.style.color = "var(--muted)";
  }
}

// ─── Load Messages ────────────────────────────────────────────────────────────
function loadMessages(contactMobile) {
  const chatId = generateChatId(myMobile, contactMobile);
  const msgCol = collection(db, `pvt_msg_${chatId}`);
  const q = query(msgCol, orderBy("timestamp", "asc"), limit(100));

  const area = document.getElementById("messages-area");
  area.innerHTML = "";

  let lastDate = "";

  messagesUnsub = onSnapshot(q, (snap) => {
    area.innerHTML = "";
    lastDate = "";

    snap.docs.forEach(d => {
      const msg = { id: d.id, ...d.data() };

      // Date divider
      const dateStr = formatDate(msg.timestamp);
      if (dateStr !== lastDate) {
        lastDate = dateStr;
        area.innerHTML += `<div class="date-divider"><span class="date-badge">${dateStr}</span></div>`;
      }

      const isMe = msg.senderMobile === myMobile;
      const time = formatTime(msg.timestamp);
      const readMark = isMe
        ? `<span class="tick ${msg.read ? 'read' : ''}">✓✓</span>`
        : "";

      let contentHtml = "";
      if (msg.isDeleted) {
        contentHtml = `<i style="color:var(--muted)">🚫 Message deleted</i>`;
      } else if (msg.fileType?.startsWith("image")) {
        contentHtml = `<img class="bubble-img" src="${msg.fileUrl}" loading="lazy" onclick="window.open('${msg.fileUrl}')" />`;
        if (msg.text) contentHtml += `<div style="margin-top:4px">${escHtml(msg.text)}</div>`;
      } else if (msg.fileType?.startsWith("video")) {
        contentHtml = `<video controls style="max-width:260px;border-radius:6px" src="${msg.fileUrl}"></video>`;
      } else if (msg.fileType?.startsWith("audio")) {
        contentHtml = `<audio controls src="${msg.fileUrl}" style="width:200px"></audio>`;
      } else if (msg.isCallLog) {
        const icon = msg.callType === "video" ? "📹" : "📞";
        contentHtml = `<span style="color:var(--muted)">${icon} ${msg.callStatus || "Call"}</span>`;
      } else {
        contentHtml = escHtml(msg.text || "");
      }

      // Reply preview
      let replyHtml = "";
      if (msg.replyToText) {
        replyHtml = `<div style="background:rgba(0,0,0,0.2);border-left:3px solid var(--green);padding:4px 8px;border-radius:4px;margin-bottom:6px;font-size:12px;color:var(--muted)">${escHtml(msg.replyToText)}</div>`;
      }

      if (msg.reaction) {
        contentHtml += `<div style="font-size:18px;margin-top:2px">${msg.reaction}</div>`;
      }

      area.innerHTML += `
        <div class="msg-wrapper ${isMe ? 'out' : ''}" id="msg-${msg.id}">
          <div class="bubble ${isMe ? 'out' : 'in'}">
            ${replyHtml}
            ${contentHtml}
            <div class="bubble-time">${time} ${readMark}</div>
          </div>
        </div>`;
    });

    // Scroll to bottom
    area.scrollTop = area.scrollHeight;
  });
}

function markRead(contactMobile) {
  const chatId = generateChatId(myMobile, contactMobile);
  const q = query(
    collection(db, `pvt_msg_${chatId}`),
    where("senderMobile", "==", contactMobile),
    where("read", "==", false)
  );
  getDocs(q).then(snap => {
    snap.docs.forEach(d => updateDoc(d.ref, { read: true }));
  });
}

// ─── Send Message ─────────────────────────────────────────────────────────────
window.sendMessage = async function() {
  const input = document.getElementById("msg-input");
  const text = input.value.trim();
  if (!text || !activeContact) return;
  input.value = "";
  autoResize(input);
  clearTyping();

  const chatId = generateChatId(myMobile, activeContact.mobile);
  const now = Date.now();
  await addDoc(collection(db, `pvt_msg_${chatId}`), {
    text,
    senderMobile: myMobile,
    receiverMobile: activeContact.mobile,
    timestamp: now,
    timeString: formatTime(now),
    read: false,
    delivered: false,
    isDeleted: false,
    isCallLog: false
  });
};

window.handleInputKey = function(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    window.sendMessage();
  }
};

window.autoResize = function(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
};

// ─── Typing indicator ─────────────────────────────────────────────────────────
window.handleTyping = function() {
  if (!activeContact || !myMobile) return;
  updateDoc(doc(db, "chat_users", myMobile), { typingTo: activeContact.mobile });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(clearTyping, 2500);
};

function clearTyping() {
  if (!myMobile) return;
  updateDoc(doc(db, "chat_users", myMobile), { typingTo: null }).catch(() => {});
}

function listenTyping(contactMobile) {
  onSnapshot(doc(db, "chat_users", contactMobile), (snap) => {
    const isTyping = snap.data()?.typingTo === myMobile;
    document.getElementById("typing-row").style.display = isTyping ? "block" : "none";
    updateContactStatus({ ...snap.data(), mobile: contactMobile });
  });
}

// ─── File Upload ──────────────────────────────────────────────────────────────
window.triggerFileUpload = function() {
  document.getElementById("file-input").click();
};

window.handleFileUpload = async function(input) {
  const file = input.files[0];
  if (!file || !activeContact) return;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", CLOUDINARY_PRESET);

  try {
    const res = await fetch(CLOUDINARY_URL, { method: "POST", body: fd });
    const data = await res.json();
    const url = data.secure_url;
    const chatId = generateChatId(myMobile, activeContact.mobile);
    const now = Date.now();
    await addDoc(collection(db, `pvt_msg_${chatId}`), {
      text: "",
      fileUrl: url,
      fileType: file.type,
      fileName: file.name,
      senderMobile: myMobile,
      receiverMobile: activeContact.mobile,
      timestamp: now,
      timeString: formatTime(now),
      read: false,
      delivered: false,
      isDeleted: false,
      isCallLog: false
    });
  } catch (e) {
    alert("Upload failed: " + e.message);
  }
  input.value = "";
};

// ─── Search ───────────────────────────────────────────────────────────────────
window.toggleSearch = function() {
  isSearchOpen = !isSearchOpen;
  const bar = document.getElementById("search-bar");
  bar.style.display = isSearchOpen ? "block" : "none";
  if (isSearchOpen) document.getElementById("search-input").focus();
  else { document.getElementById("search-input").value = ""; renderContacts(allUsers); }
};

window.filterContacts = function(val) { renderContacts(allUsers, val); };

// ─── Logout ───────────────────────────────────────────────────────────────────
window.logout = async function() {
  clearTyping();
  await auth.signOut();
  localStorage.clear();
  window.location.href = "index.html";
};

// ─── WebRTC Calls ─────────────────────────────────────────────────────────────
const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

window.startCall = async function(type) {
  if (!activeContact) return;
  currentCallType = type;
  callId = `${myMobile}_${activeContact.mobile}_${Date.now()}`;

  showCallOverlay(activeContact.name, "Calling...");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video"
    });

    if (type === "video") {
      document.getElementById("video-container").style.display = "block";
      document.getElementById("localVideo").srcObject = localStream;
    }

    peerConnection = new RTCPeerConnection({ iceServers });

    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

    peerConnection.ontrack = (e) => {
      if (type === "video" && e.streams[0]) {
        document.getElementById("remoteVideo").srcObject = e.streams[0];
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(peerConnection.iceConnectionState)) {
        endCall();
      } else if (peerConnection.iceConnectionState === "connected") {
        document.getElementById("call-status-overlay").textContent = "Connected";
      }
    };

    // Collect ICE candidates
    const iceCandidates = [];
    peerConnection.onicecandidate = async (e) => {
      if (e.candidate) {
        await addDoc(collection(db, "calls", callId, "caller_ice"), e.candidate.toJSON());
      }
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // Save call to Firestore
    await setDoc(doc(db, "calls", callId), {
      caller: myMobile,
      callerName: myName,
      callee: activeContact.mobile,
      type,
      status: "calling",
      timestamp: Date.now(),
      offer: { type: offer.type, sdp: offer.sdp }
    });

    // Listen for answer
    callUnsub = onSnapshot(doc(db, "calls", callId), async (snap) => {
      const data = snap.data();
      if (!data) return;
      if (data.status === "answered" && data.answer && peerConnection.signalingState !== "stable") {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
      if (data.status === "declined" || data.status === "ended") { endCall(); }
    });

    // Listen for remote ICE
    onSnapshot(collection(db, "calls", callId, "callee_ice"), (snap) => {
      snap.docChanges().forEach(c => {
        if (c.type === "added") peerConnection.addIceCandidate(new RTCIceCandidate(c.doc.data()));
      });
    });

  } catch (e) {
    alert("Call failed: " + e.message);
    endCall();
  }
};

window.endCall = async function() {
  if (callId) {
    await updateDoc(doc(db, "calls", callId), { status: "ended" }).catch(() => {});
  }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (callUnsub) { callUnsub(); callUnsub = null; }
  document.getElementById("call-overlay").style.display = "none";
  document.getElementById("video-container").style.display = "none";
  callId = null;
};

window.toggleMute = function() {
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  const btn = document.getElementById("mute-btn");
  btn.querySelector(".btn-circle").style.background = isMuted ? "var(--green)" : "var(--border)";
  document.getElementById("mute-label").textContent = isMuted ? "Unmute" : "Mute";
};

window.toggleSpeaker = function() {
  isSpeakerOn = !isSpeakerOn;
  document.getElementById("speaker-btn").querySelector(".btn-circle").style.background =
    isSpeakerOn ? "var(--green)" : "var(--border)";
  document.getElementById("speaker-label").textContent = isSpeakerOn ? "Earphone" : "Speaker";
};

function showCallOverlay(name, status) {
  const overlay = document.getElementById("call-overlay");
  overlay.style.display = "flex";
  const initials = name ? name.charAt(0).toUpperCase() : "?";
  document.getElementById("call-avatar-overlay").textContent = initials;
  document.getElementById("call-name-overlay").textContent = name;
  document.getElementById("call-status-overlay").textContent = status;
}

// Listen for incoming calls
function listenIncomingCalls() {
  onSnapshot(
    query(collection(db, "calls"), where("callee", "==", myMobile), where("status", "==", "calling")),
    (snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type !== "added") return;
        const data = change.doc.data();
        const id = change.doc.id;

        // Don't show if already in a call
        if (callId) return;

        const answer = confirm(`📞 Incoming ${data.type} call from ${data.callerName || data.caller}.\n\nAnswer?`);
        if (!answer) {
          await updateDoc(doc(db, "calls", id), { status: "declined" });
          return;
        }

        callId = id;
        currentCallType = data.type;
        showCallOverlay(data.callerName || data.caller, "Connecting...");

        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: data.type === "video"
          });

          if (data.type === "video") {
            document.getElementById("video-container").style.display = "block";
            document.getElementById("localVideo").srcObject = localStream;
          }

          peerConnection = new RTCPeerConnection({ iceServers });
          localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

          peerConnection.ontrack = (e) => {
            if (data.type === "video" && e.streams[0]) {
              document.getElementById("remoteVideo").srcObject = e.streams[0];
            }
          };

          peerConnection.onicecandidate = async (e) => {
            if (e.candidate) {
              await addDoc(collection(db, "calls", id, "callee_ice"), e.candidate.toJSON());
            }
          };

          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
          const answer2 = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer2);
          await updateDoc(doc(db, "calls", id), {
            status: "answered",
            answer: { type: answer2.type, sdp: answer2.sdp }
          });

          // Remote ICE
          onSnapshot(collection(db, "calls", id, "caller_ice"), (snap2) => {
            snap2.docChanges().forEach(c => {
              if (c.type === "added") peerConnection.addIceCandidate(new RTCIceCandidate(c.doc.data()));
            });
          });

          callUnsub = onSnapshot(doc(db, "calls", id), (s) => {
            if (s.data()?.status === "ended") endCall();
          });

        } catch (e) {
          alert("Failed to answer: " + e.message);
          endCall();
        }
      });
    }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateChatId(a, b) {
  return [a, b].sort().join("_");
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatLastSeen(ts) {
  if (!ts) return "a while ago";
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.floor(diff / 60000) + " min ago";
  if (diff < 86400000) return "today at " + formatTime(ts);
  return new Date(ts).toLocaleDateString();
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br/>");
}

window.showProfileMenu = function() {};

// Start
listenIncomingCalls();
