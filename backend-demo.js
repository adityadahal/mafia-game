/**
 * Demo backend — the same interface as backend-firebase.js, but backed by
 * localStorage instead of a network. Activated with ?demo=1 in the URL.
 *
 * Rooms are shared between tabs of the same browser (localStorage), while each
 * tab gets its own identity (sessionStorage), so you can open three tabs and
 * play host + two players without any Firebase project.
 *
 * NOT private: every tab can read the whole fake database. It exists so you can
 * exercise the flow before setup, and so the UI can be tested. Real privacy
 * comes from the Firebase security rules in database.rules.json.
 */

import { RoomError } from "./backend-firebase.js";

const DB_KEY = "mafia.demo.db";
const UID_KEY = "mafia.demo.uid";

function readDb() {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY)) || { rooms: {} };
  } catch (_) {
    return { rooms: {} };
  }
}

function valueAt(path) {
  let node = readDb();
  for (const key of path) {
    if (node == null || typeof node !== "object") return null;
    node = node[key];
  }
  return node === undefined ? null : node;
}

const watchers = new Set();

function notify() {
  for (const w of watchers) w.callback(valueAt(w.path));
}

function writeDb(mutate) {
  const db = readDb();
  mutate(db);
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  notify();
}

// Another tab wrote — refresh every watcher in this one.
window.addEventListener("storage", (e) => {
  if (e.key === DB_KEY) notify();
});

function watch(path, callback, transform) {
  const entry = { path, callback: (v) => callback(transform ? transform(v) : v) };
  watchers.add(entry);
  entry.callback(valueAt(path)); // fire once immediately, like onValue does
  return () => watchers.delete(entry);
}

export async function createBackend() {
  return {
    name: "demo",

    async signIn() {
      let uid = sessionStorage.getItem(UID_KEY);
      if (!uid) {
        uid = "demo_" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(UID_KEY, uid);
      }
      return uid;
    },

    async roomMeta(code) {
      return valueAt(["rooms", code, "meta"]);
    },

    async createRoom({ code, hostUid, mafiaCount }) {
      writeDb((db) => {
        db.rooms[code] = { meta: { hostUid, status: "lobby", mafiaCount, createdAt: Date.now() } };
      });
    },

    async setMafiaCount(code, mafiaCount) {
      writeDb((db) => {
        if (db.rooms[code]) db.rooms[code].meta.mafiaCount = mafiaCount;
      });
    },

    async joinRoom({ code, uid, name }) {
      const meta = await this.roomMeta(code);
      if (!meta) throw new RoomError("not-found", "No room with that code.");
      if (meta.status !== "lobby") throw new RoomError("started", "That game has already started.");

      writeDb((db) => {
        const room = db.rooms[code];
        room.players = room.players || {};
        room.players[uid] = { name, joinedAt: Date.now() };
      });
    },

    async stopAutoLeave() { /* no disconnect hooks in demo mode */ },

    async leaveRoom({ code, uid }) {
      writeDb((db) => {
        const players = db.rooms[code] && db.rooms[code].players;
        if (players) delete players[uid];
      });
    },

    watchPlayers(code, callback) {
      return watch(["rooms", code, "players"], callback, (v) => v || {});
    },

    watchMeta(code, callback) {
      return watch(["rooms", code, "meta"], callback);
    },

    watchMyRole({ code, uid }, callback) {
      return watch(["rooms", code, "roles", uid], callback);
    },

    watchAllRoles(code, callback) {
      return watch(["rooms", code, "roles"], callback, (v) => v || {});
    },

    watchMafiaTeam(code, callback) {
      return watch(["rooms", code, "mafiaTeam"], callback, (v) => v || []);
    },

    async dealRoles({ code, roles, mafiaTeam }) {
      writeDb((db) => {
        const room = db.rooms[code];
        room.roles = roles;
        room.mafiaTeam = mafiaTeam;
        room.meta.status = "dealt";
      });
    },

    async closeRoom(code) {
      writeDb((db) => { delete db.rooms[code]; });
    }
  };
}
