/**
 * Mafia — role dealer.
 *
 * Two ways to play, sharing the same role logic (roles.js):
 *   • One device  — pass the phone around, no network at all.
 *   • Online      — host shows a room code, players join from their own phones
 *                   and each sees only their own role.
 *
 * The online transport sits behind a small interface (see backend-firebase.js),
 * so the UI never touches Firebase directly.
 */

import {
  MIN_PLAYERS, MAX_PLAYERS, DOCTORS, ROLES,
  shuffle, suggestedMafia, civiliansFor, buildRolePool, makeRoomCode
} from "./roles.js";

import { isConfigured, createBackend as createFirebaseBackend } from "./backend-firebase.js";

const DEMO = new URLSearchParams(location.search).has("demo");

/* In demo mode each browser tab pretends to be a separate device, so the
   session must not be shared between tabs. */
const store = DEMO ? sessionStorage : localStorage;

const SESSION_KEY = "mafia.session.v1"; // online session
const LOCAL_KEY = "mafia.game.v1";      // one-device game

/* ------------------------------------------------------------------ *
 * Tiny helpers
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const TAGLINES = {
  home: "Deal roles to your table",
  setup: "Pass-the-device role dealer",
  reveal: "Pass-the-device role dealer",
  summary: "Pass-the-device role dealer",
  "host-lobby": "You are the narrator",
  "host-game": "You are the narrator",
  join: "Your role, on your phone",
  wait: "Your role, on your phone",
  role: "Your role, on your phone"
};

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  $("screen-" + name).classList.add("active");
  $("tagline").textContent = TAGLINES[name] || TAGLINES.home;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 3600);
}

function compositionChips(target, playerCount, mafiaCount) {
  const civilians = civiliansFor(playerCount, mafiaCount);
  const parts = [
    ["mafia", mafiaCount, "Mafia"],
    ["doctor", DOCTORS, "Doctor"],
    ["civilian", civilians, civilians === 1 ? "Civilian" : "Civilians"]
  ];

  target.innerHTML = "";
  for (const [key, n, label] of parts) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = '<i class="dot ' + key + '"></i><b>' + n + "</b> " + label;
    target.appendChild(chip);
  }
}

function renderRoster(target, entries, open) {
  target.innerHTML = "";

  entries.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "roster-row";

    const num = document.createElement("div");
    num.className = "num";
    num.textContent = i + 1;

    const who = document.createElement("div");
    who.className = "who";
    who.textContent = entry.name;

    const tag = document.createElement("div");
    if (open && entry.role) {
      tag.className = "tag " + entry.role;
      tag.textContent = ROLES[entry.role].label;
    } else {
      tag.className = "tag hidden-tag";
      tag.textContent = "•••";
    }

    row.append(num, who, tag);
    target.appendChild(row);
  });
}

/** The shared face-down / face-up card used by both modes. */
function renderCard(el, { name, role, revealed, teammates, hint }) {
  el.className = "reveal-card";

  if (!revealed || !role) {
    el.setAttribute("aria-label", "Tap to reveal the role for " + name);
    el.innerHTML =
      '<div class="face">' +
        '<div class="lock">\u{1F0A0}</div>' +
        '<div class="player-name">' + escapeHtml(name) + "</div>" +
        '<div class="tap-hint">' + escapeHtml(hint || "Make sure nobody is looking, then tap") + "</div>" +
      "</div>";
    return;
  }

  const info = ROLES[role];
  el.classList.add(role);
  el.setAttribute("aria-label", name + " is " + info.label);

  let teammatesHtml = "";
  if (role === "mafia" && teammates) {
    teammatesHtml = teammates.length
      ? '<div class="teammates">Your partner: <b>' + escapeHtml(teammates.join(", ")) + "</b></div>"
      : '<div class="teammates">You work <b>alone</b>.</div>';
  }

  el.innerHTML =
    '<div class="face">' +
      '<div class="role-emoji">' + info.emoji + "</div>" +
      '<div class="role-name ' + role + '">' + info.label + "</div>" +
      '<div class="role-desc">' + info.desc + "</div>" +
      teammatesHtml +
    "</div>";
}

/* ================================================================== *
 * ONE-DEVICE MODE
 * ================================================================== */
const L = {
  playerCount: 8,
  mafiaCount: 1,
  names: [],
  deal: [],
  order: [],
  cursor: 0,
  revealed: false,
  rosterOpen: false
};

const localName = (i) => (L.names[i] || "").trim() || "Player " + (i + 1);

function renderNameInputs() {
  const box = $("name-inputs");

  for (let i = box.children.length; i < L.playerCount; i++) {
    const row = document.createElement("div");
    row.className = "name-row";

    const num = document.createElement("div");
    num.className = "num";
    num.textContent = (i + 1) + ".";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 24;
    input.placeholder = "Player " + (i + 1);
    input.value = L.names[i] || "";
    input.addEventListener("input", () => { L.names[i] = input.value; });

    row.append(num, input);
    box.appendChild(row);
  }

  while (box.children.length > L.playerCount) box.removeChild(box.lastChild);
}

function renderSetup() {
  $("count-display").textContent = L.playerCount;
  $("minus").disabled = L.playerCount <= MIN_PLAYERS;
  $("plus").disabled = L.playerCount >= MAX_PLAYERS;

  document.querySelectorAll("#mafia-seg button").forEach((btn) => {
    const value = Number(btn.dataset.mafia);
    btn.setAttribute("aria-pressed", String(value === L.mafiaCount));
    btn.disabled = civiliansFor(L.playerCount, value) < 1;
  });

  compositionChips($("composition"), L.playerCount, L.mafiaCount);

  $("warning").textContent = warningFor(L.playerCount, L.mafiaCount);
  $("deal").disabled = civiliansFor(L.playerCount, L.mafiaCount) < 1;

  renderNameInputs();
}

function warningFor(playerCount, mafiaCount) {
  if (civiliansFor(playerCount, mafiaCount) < 1) return "Not enough players for that many mafia.";
  if (mafiaCount * 2 >= playerCount) return "Mafia are already half the table — they win on the spot.";
  if (playerCount >= 9 && mafiaCount === 1) return "Tip: with " + playerCount + " players, 2 mafia plays better.";
  return "";
}

function setPlayerCount(n) {
  L.playerCount = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
  if (civiliansFor(L.playerCount, L.mafiaCount) < 1) L.mafiaCount = 1;
  renderSetup();
}

function localDeal() {
  const pool = buildRolePool(L.playerCount, L.mafiaCount);

  L.deal = pool.map((role, i) => ({ name: localName(i), role }));
  // Shuffle the pass-around order too, so turn order leaks nothing.
  L.order = shuffle(L.deal.map((_, i) => i));
  L.cursor = 0;
  L.revealed = false;
  L.rosterOpen = false;

  saveLocal();
  renderReveal();
  showScreen("reveal");
}

const localCurrent = () => L.deal[L.order[L.cursor]];

function renderReveal() {
  const total = L.deal.length;
  const player = localCurrent();
  if (!player) return;

  $("progress-label").textContent = "Player " + (L.cursor + 1) + " of " + total;
  $("progress-left").textContent = (total - L.cursor - 1) + " left";
  $("progress-bar").style.width = (L.cursor / total) * 100 + "%";

  const teammates = player.role === "mafia"
    ? L.deal.filter((p) => p.role === "mafia" && p !== player).map((p) => p.name)
    : null;

  renderCard($("reveal-card"), { name: player.name, role: player.role, revealed: L.revealed, teammates });

  $("next").textContent = !L.revealed
    ? "Reveal"
    : (L.cursor === total - 1 ? "Done — hide" : "Hide & pass on");
}

function advance() {
  if (!localCurrent()) return; // already handed out, or a tampered saved cursor

  if (!L.revealed) {
    L.revealed = true;
    renderReveal();
    return;
  }

  L.revealed = false;

  if (L.cursor < L.deal.length - 1) {
    L.cursor++;
    saveLocal();
    renderReveal();
    return;
  }

  L.cursor = L.deal.length; // the whole deal has been handed out
  saveLocal();
  renderLocalSummary();
  showScreen("summary");
}

function renderLocalSummary() {
  compositionChips($("summary-composition"), L.deal.length, L.mafiaCount);
  renderRoster($("roster"), L.deal, L.rosterOpen);
  $("toggle-roster").textContent = L.rosterOpen ? "Hide roles" : "Reveal all roles";
  $("roster-hint").textContent = L.rosterOpen
    ? "Revealed. Everyone can see who was who."
    : "Hidden. Reveal only when the game is over.";
}

function saveLocal() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({
      playerCount: L.playerCount, mafiaCount: L.mafiaCount, names: L.names,
      deal: L.deal, order: L.order, cursor: L.cursor, rosterOpen: L.rosterOpen
    }));
  } catch (_) { /* private mode or full storage — the game still works */ }
}

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_KEY));
    if (!saved || !Array.isArray(saved.deal) || !saved.deal.length) return false;

    Object.assign(L, {
      playerCount: saved.playerCount,
      mafiaCount: saved.mafiaCount,
      names: saved.names || [],
      deal: saved.deal,
      order: saved.order,
      cursor: saved.cursor || 0,
      rosterOpen: !!saved.rosterOpen,
      revealed: false // always resume face-down
    });
    return true;
  } catch (_) {
    return false;
  }
}

const clearLocal = () => { try { localStorage.removeItem(LOCAL_KEY); } catch (_) {} };

function localBackToSetup(keepNames) {
  clearLocal();
  L.deal = [];
  L.order = [];
  L.cursor = 0;
  L.revealed = false;
  L.rosterOpen = false;

  if (!keepNames) {
    L.names = [];
    $("name-inputs").innerHTML = "";
  }

  renderSetup();
  showScreen("setup");
}

/* ================================================================== *
 * ONLINE MODE
 * ================================================================== */
const O = {
  uid: null,
  code: null,
  name: null,
  isHost: false,
  mafiaCount: 1,
  players: {},   // uid -> { name }
  roles: {},     // uid -> role   (host only)
  myRole: null,
  mafiaTeam: null,   // null = not known yet, [] = you're the only mafia
  revealed: false,
  rosterOpen: false,
  unsubs: [],
  teamUnsub: null
};

let backend = null;

async function getBackend() {
  if (backend) return backend;
  backend = DEMO
    ? await (await import("./backend-demo.js")).createBackend()
    : await createFirebaseBackend();
  return backend;
}

/** Resolves to a backend, or null after explaining why it can't. */
async function requireBackend() {
  if (!DEMO && !isConfigured()) {
    toast("Add your Firebase config to play online — see README.md", true);
    return null;
  }
  try {
    return await getBackend();
  } catch (err) {
    console.error(err);
    toast("Couldn't reach the server. Check your connection.", true);
    return null;
  }
}

function stopWatchingTeam() {
  if (!O.teamUnsub) return;
  try { O.teamUnsub(); } catch (_) {}
  O.teamUnsub = null;
}

function stopWatching() {
  O.unsubs.forEach((unsub) => { try { unsub(); } catch (_) {} });
  O.unsubs = [];
  stopWatchingTeam();
}

function resetOnline() {
  stopWatching();
  Object.assign(O, {
    code: null, name: null, isHost: false, players: {}, roles: {},
    myRole: null, mafiaTeam: null, revealed: false, rosterOpen: false
  });
  clearSession();
  updateFooter();
}

const saveSession = (session) => {
  try { store.setItem(SESSION_KEY, JSON.stringify(session)); } catch (_) {}
};

const loadSession = () => {
  try { return JSON.parse(store.getItem(SESSION_KEY)); } catch (_) { return null; }
};

const clearSession = () => { try { store.removeItem(SESSION_KEY); } catch (_) {} };

function updateFooter() {
  const bits = [];
  if (DEMO) bits.push("Demo mode");
  if (O.code) bits.push("Room " + O.code);
  $("footer-mode").textContent = bits.length ? " · " + bits.join(" · ") : "";
}

/* ---------------------------- host ---------------------------- */
async function startHosting() {
  const be = await requireBackend();
  if (!be) return;

  try {
    O.uid = await be.signIn();

    let code = makeRoomCode();
    for (let attempt = 0; attempt < 5 && await be.roomMeta(code); attempt++) {
      code = makeRoomCode(); // vanishingly rare, but don't hijack a live room
    }

    O.mafiaCount = 1;
    await be.createRoom({ code, hostUid: O.uid, mafiaCount: O.mafiaCount });

    O.code = code;
    O.isHost = true;
    saveSession({ role: "host", code });
    updateFooter();

    watchAsHost();
    renderHostLobby();
    showScreen("host-lobby");
  } catch (err) {
    console.error(err);
    toast("Couldn't create the room. " + friendlyError(err), true);
  }
}

function watchAsHost() {
  const be = backend;
  stopWatching();

  O.unsubs.push(be.watchPlayers(O.code, (players) => {
    O.players = players;
    renderHostLobby();
    renderHostGame();
  }));

  O.unsubs.push(be.watchAllRoles(O.code, (roles) => {
    O.roles = roles;
    renderHostGame();
  }));

  O.unsubs.push(be.watchMeta(O.code, (meta) => {
    if (!meta) return; // room removed elsewhere; host screens simply stop updating
    O.mafiaCount = meta.mafiaCount || 1;
  }));
}

const playerEntries = () =>
  Object.entries(O.players)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([uid, player]) => ({ uid, name: player.name, role: O.roles[uid] || null }));

function renderHostLobby() {
  const entries = playerEntries();
  const count = entries.length;

  $("room-code").textContent = O.code || "----";

  $("lobby-count").textContent = count === 0
    ? "Waiting for players…"
    : count + (count === 1 ? " player joined" : " players joined") +
      (count < MIN_PLAYERS ? " · need " + (MIN_PLAYERS - count) + " more" : "");

  const list = $("lobby-players");
  list.innerHTML = "";
  if (!count) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nobody yet.";
    list.appendChild(empty);
  } else {
    for (const entry of entries) {
      const pill = document.createElement("div");
      pill.className = "pill";
      pill.textContent = entry.name;
      list.appendChild(pill);
    }
  }

  document.querySelectorAll("#host-mafia-seg button").forEach((btn) => {
    const value = Number(btn.dataset.mafia);
    btn.setAttribute("aria-pressed", String(value === O.mafiaCount));
    btn.disabled = count > 0 && civiliansFor(count, value) < 1;
  });

  compositionChips($("host-composition"), Math.max(count, MIN_PLAYERS), O.mafiaCount);

  $("host-warning").textContent = count < MIN_PLAYERS
    ? "Need at least " + MIN_PLAYERS + " players to deal."
    : warningFor(count, O.mafiaCount);

  $("host-deal").disabled = count < MIN_PLAYERS || civiliansFor(count, O.mafiaCount) < 1;
}

function renderHostGame() {
  const entries = playerEntries();
  $("host-game-code").textContent = O.code || "----";
  compositionChips($("host-game-composition"), entries.length, O.mafiaCount);
  renderRoster($("host-roster"), entries, O.rosterOpen);

  $("host-toggle-roster").textContent = O.rosterOpen ? "Hide roles" : "Reveal all roles";
  $("host-roster-hint").textContent = O.rosterOpen
    ? "Revealed. Everyone can see who was who."
    : "Hidden. Reveal only when the game is over.";
}

async function hostDeal() {
  const entries = playerEntries();
  if (entries.length < MIN_PLAYERS) return;

  const pool = buildRolePool(entries.length, O.mafiaCount);
  const roles = {};
  entries.forEach((entry, i) => { roles[entry.uid] = pool[i]; });

  const mafiaTeam = entries.filter((e) => roles[e.uid] === "mafia").map((e) => e.name);

  try {
    await backend.dealRoles({ code: O.code, roles, mafiaTeam });
    O.rosterOpen = false;
    renderHostGame();
    showScreen("host-game");
  } catch (err) {
    console.error(err);
    toast("Couldn't deal roles. " + friendlyError(err), true);
  }
}

async function hostEndGame() {
  if (!confirm("End the game and close the room for everyone?")) return;
  try {
    await backend.closeRoom(O.code);
  } catch (err) {
    console.error(err);
  }
  resetOnline();
  showScreen("home");
}

/* --------------------------- player --------------------------- */
async function joinGame(code, name) {
  const be = await requireBackend();
  if (!be) return;

  try {
    O.uid = await be.signIn();
    await be.joinRoom({ code, uid: O.uid, name });

    O.code = code;
    O.name = name;
    O.isHost = false;
    O.myRole = null;
    O.revealed = false;
    saveSession({ role: "player", code, name });
    updateFooter();

    watchAsPlayer();
    showScreen("wait");
  } catch (err) {
    $("join-error").textContent = friendlyError(err);
    // "wrong code" and "already started" are normal outcomes, not faults worth logging.
    if (!err || (err.code !== "not-found" && err.code !== "started")) console.error(err);
  }
}

function watchAsPlayer() {
  const be = backend;
  stopWatching();

  O.unsubs.push(be.watchMeta(O.code, (meta) => {
    if (!meta) {
      toast("The host ended the game.");
      resetOnline();
      showScreen("home");
    }
  }));

  O.unsubs.push(be.watchPlayers(O.code, (players) => {
    O.players = players;
    renderWaiting();
  }));

  O.unsubs.push(be.watchMyRole({ code: O.code, uid: O.uid }, (role) => {
    if (role === O.myRole) return;

    O.myRole = role;
    O.revealed = false; // a fresh deal always arrives face-down
    O.mafiaTeam = null;
    stopWatchingTeam();

    if (!role) {
      renderWaiting();
      showScreen("wait");
      return;
    }

    // Mafia get a live subscription: the team list may arrive after the role does.
    if (role === "mafia") {
      O.teamUnsub = be.watchMafiaTeam(O.code, (team) => {
        O.mafiaTeam = team.filter((name) => name !== O.name);
        renderPlayerCard();
      });
    }

    renderPlayerCard();
    showScreen("role");
  }));
}

function renderWaiting() {
  const count = Object.keys(O.players).length;
  $("wait-code").textContent = O.code || "----";
  $("wait-name").textContent = O.name || "you";
  $("wait-count").textContent = count
    ? count + (count === 1 ? " player in the room" : " players in the room") + " · waiting for the host…"
    : "Waiting for the host…";

  const list = $("wait-players");
  list.innerHTML = "";
  for (const [uid, player] of Object.entries(O.players)) {
    const pill = document.createElement("div");
    pill.className = "pill" + (uid === O.uid ? " me" : "");
    pill.textContent = player.name;
    list.appendChild(pill);
  }
}

function renderPlayerCard() {
  $("role-who").textContent = O.name || "You";
  $("role-room").textContent = "Room " + (O.code || "----");

  renderCard($("player-card"), {
    name: O.name || "You",
    role: O.myRole,
    revealed: O.revealed,
    teammates: O.mafiaTeam,
    hint: "Tap when you're ready to look"
  });

  $("player-toggle").textContent = O.revealed ? "Hide" : "Reveal";
}

async function leaveGame() {
  try {
    if (O.code && O.uid) await backend.leaveRoom({ code: O.code, uid: O.uid });
  } catch (err) {
    console.error(err);
  }
  resetOnline();
  showScreen("home");
}

/** Turns the errors you actually hit during setup into the fix for each one. */
function friendlyError(err) {
  const code = (err && typeof err.code === "string") ? err.code : "";

  if (code === "not-found") return "No room with that code.";
  if (code === "started") return "That game has already started.";

  if (code.startsWith("auth/api-key-not-valid")) {
    return "That API key isn't valid — check firebase-config.js.";
  }
  if (code === "auth/unauthorized-domain") {
    return "This domain isn't authorized in Firebase — add it under Authentication → Settings → Authorized domains.";
  }
  if (code === "auth/operation-not-allowed" || code === "auth/admin-restricted-operation") {
    return "Anonymous sign-in is off — enable it under Authentication → Sign-in method.";
  }
  if (code === "auth/network-request-failed") {
    return "Couldn't reach Firebase — check your connection.";
  }
  if (code === "PERMISSION_DENIED" || /permission_denied/i.test((err && err.message) || "")) {
    return "The database rules rejected that — is database.rules.json published?";
  }

  return (err && err.message) || "Something went wrong.";
}

/* ---------------------- resume after refresh ---------------------- */
async function resumeSession() {
  const saved = loadSession();
  if (!saved || !saved.code) return false;
  if (!DEMO && !isConfigured()) return false;

  try {
    const be = await getBackend();
    O.uid = await be.signIn();

    const meta = await be.roomMeta(saved.code);
    if (!meta) {
      clearSession();
      return false;
    }

    O.code = saved.code;
    O.mafiaCount = meta.mafiaCount || 1;
    updateFooter();

    if (saved.role === "host") {
      if (meta.hostUid !== O.uid) { // different browser identity — not our room
        clearSession();
        O.code = null;
        return false;
      }
      O.isHost = true;
      watchAsHost();
      showScreen(meta.status === "dealt" ? "host-game" : "host-lobby");
      return true;
    }

    O.name = saved.name;
    // Re-register in the lobby; after dealing, the role listener takes over.
    if (meta.status === "lobby") await be.joinRoom({ code: O.code, uid: O.uid, name: O.name });
    watchAsPlayer();
    renderWaiting();
    showScreen("wait");
    return true;
  } catch (err) {
    console.error(err);
    clearSession();
    return false;
  }
}

/* ================================================================== *
 * Wiring
 * ================================================================== */

// --- home ---
$("go-host").addEventListener("click", startHosting);

$("go-join").addEventListener("click", () => {
  $("join-error").textContent = "";
  showScreen("join");
  $("join-code").focus();
});

$("go-local").addEventListener("click", () => {
  L.mafiaCount = suggestedMafia(L.playerCount);
  renderSetup();
  showScreen("setup");
});

// --- one device ---
$("minus").addEventListener("click", () => setPlayerCount(L.playerCount - 1));
$("plus").addEventListener("click", () => setPlayerCount(L.playerCount + 1));

$("mafia-seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mafia]");
  if (!btn || btn.disabled) return;
  L.mafiaCount = Number(btn.dataset.mafia);
  renderSetup();
});

$("deal").addEventListener("click", localDeal);
$("setup-back").addEventListener("click", () => showScreen("home"));
$("next").addEventListener("click", advance);
$("reveal-card").addEventListener("click", () => { if (!L.revealed) advance(); });

$("reveal-card").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); advance(); }
});

$("abort").addEventListener("click", () => {
  if (confirm("Discard this deal and go back to setup?")) localBackToSetup(true);
});

$("toggle-roster").addEventListener("click", () => {
  if (!L.rosterOpen && !confirm("Reveal every role to the room?")) return;
  L.rosterOpen = !L.rosterOpen;
  saveLocal();
  renderLocalSummary();
});

$("replay").addEventListener("click", localDeal);
$("new-game").addEventListener("click", () => localBackToSetup(false));

// --- host ---
$("host-mafia-seg").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-mafia]");
  if (!btn || btn.disabled) return;
  O.mafiaCount = Number(btn.dataset.mafia);
  renderHostLobby();
  try { await backend.setMafiaCount(O.code, O.mafiaCount); } catch (err) { console.error(err); }
});

$("host-deal").addEventListener("click", hostDeal);
$("host-redeal").addEventListener("click", hostDeal);
$("host-end").addEventListener("click", hostEndGame);
$("host-close").addEventListener("click", hostEndGame);

$("copy-link").addEventListener("click", async () => {
  const link = location.origin + location.pathname + (DEMO ? "?demo=1" : "") + "#join=" + O.code;
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite link copied");
  } catch (_) {
    prompt("Copy this link:", link); // clipboard blocked (http, or an old browser)
  }
});

$("host-toggle-roster").addEventListener("click", () => {
  if (!O.rosterOpen && !confirm("Reveal every role to the room?")) return;
  O.rosterOpen = !O.rosterOpen;
  renderHostGame();
});

// --- player ---
$("join-code").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
});

$("join-submit").addEventListener("click", () => {
  const code = $("join-code").value.trim().toUpperCase();
  const name = $("join-name").value.trim();

  if (code.length !== 4) return void ($("join-error").textContent = "Room codes are four letters.");
  if (!name) return void ($("join-error").textContent = "Enter a name so the host knows who you are.");

  $("join-error").textContent = "";
  joinGame(code, name);
});

$("join-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-submit").click(); });
$("join-back").addEventListener("click", () => showScreen("home"));
$("wait-leave").addEventListener("click", leaveGame);
$("player-leave").addEventListener("click", leaveGame);

$("player-toggle").addEventListener("click", () => {
  O.revealed = !O.revealed;
  renderPlayerCard();
});

$("player-card").addEventListener("click", () => {
  if (!O.revealed) { O.revealed = true; renderPlayerCard(); }
});

$("player-card").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    O.revealed = !O.revealed;
    renderPlayerCard();
  }
});

// --- footer ---
$("go-home").addEventListener("click", () => {
  if (O.code && !confirm("Leave the current room?")) return;
  if (O.code) return void leaveGame();
  showScreen("home");
});

/* ================================================================== *
 * Boot
 * ================================================================== */
(async function boot() {
  L.mafiaCount = suggestedMafia(L.playerCount);
  renderSetup();
  updateFooter();

  const online = DEMO || isConfigured();
  $("demo-banner").hidden = !DEMO;
  $("setup-banner").hidden = online;

  if (!online) {
    $("go-host").disabled = true;
    $("go-join").disabled = true;

    const link = document.createElement("a");
    link.href = "?demo=1";
    link.textContent = "Try the online flow in demo mode →";
    link.style.display = "inline-block";
    link.style.marginTop = "8px";
    $("setup-banner").appendChild(link);
  }

  // Invite links look like .../#join=ABCD
  const inviteMatch = location.hash.match(/^#join=([A-Za-z]{4})$/);
  if (inviteMatch && online) {
    $("join-code").value = inviteMatch[1].toUpperCase();
    showScreen("join");
    $("join-name").focus();
    return;
  }

  if (await resumeSession()) return;

  if (loadLocal()) {
    if (L.cursor >= L.deal.length) {
      renderLocalSummary();
      showScreen("summary");
    } else {
      renderReveal();
      showScreen("reveal");
    }
    return;
  }

  showScreen("home");
})();
