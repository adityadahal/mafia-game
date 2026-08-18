/**
 * Firebase Realtime Database backend.
 *
 * The SDK is pulled from Google's CDN as an ES module, so there is no npm
 * install and no build step — this works as-is on GitHub Pages.
 *
 * Every method here is also implemented by backend-demo.js against
 * localStorage, so the app can run (and be tested) without a Firebase project.
 */

import { firebaseConfig, FIREBASE_SDK_VERSION } from "./firebase-config.js";

const cdn = (module) =>
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-${module}.js`;

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'not-found' | 'started' | 'full' | 'offline'
  }
}

/** True once real values have been pasted into firebase-config.js. */
export function isConfigured() {
  const { apiKey, databaseURL } = firebaseConfig;
  return Boolean(apiKey && databaseURL) &&
    !apiKey.startsWith("PASTE") &&
    !databaseURL.startsWith("PASTE");
}

export async function createBackend() {
  const [appMod, authMod, dbMod] = await Promise.all([
    import(cdn("app")),
    import(cdn("auth")),
    import(cdn("database"))
  ]);

  const { initializeApp } = appMod;
  const { getAuth, signInAnonymously } = authMod;
  const {
    getDatabase, ref, get, set, update, remove,
    onValue, onDisconnect, serverTimestamp
  } = dbMod;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);

  const at = (...path) => ref(db, path.join("/"));

  // Kept so we can cancel the "remove me when I disconnect" hook once the
  // game starts — a dropped phone mid-game must not vanish from the roster.
  let autoLeave = null;

  return {
    name: "firebase",

    async signIn() {
      const credential = await signInAnonymously(auth);
      return credential.user.uid;
    },

    async roomMeta(code) {
      const snap = await get(at("rooms", code, "meta"));
      return snap.exists() ? snap.val() : null;
    },

    async createRoom({ code, hostUid, mafiaCount }) {
      await set(at("rooms", code), {
        meta: { hostUid, status: "lobby", mafiaCount, createdAt: serverTimestamp() }
      });
    },

    async setMafiaCount(code, mafiaCount) {
      await update(at("rooms", code, "meta"), { mafiaCount });
    },

    async joinRoom({ code, uid, name }) {
      const meta = await this.roomMeta(code);
      if (!meta) throw new RoomError("not-found", "No room with that code.");
      if (meta.status !== "lobby") throw new RoomError("started", "That game has already started.");

      const playerRef = at("rooms", code, "players", uid);
      await set(playerRef, { name, joinedAt: serverTimestamp() });

      // Leave the lobby automatically if this phone closes the tab.
      autoLeave = onDisconnect(playerRef);
      await autoLeave.remove();
    },

    async stopAutoLeave() {
      if (!autoLeave) return;
      await autoLeave.cancel();
      autoLeave = null;
    },

    async leaveRoom({ code, uid }) {
      await this.stopAutoLeave();
      await remove(at("rooms", code, "players", uid));
    },

    watchPlayers(code, callback) {
      return onValue(at("rooms", code, "players"), (snap) => callback(snap.val() || {}));
    },

    watchMeta(code, callback) {
      return onValue(at("rooms", code, "meta"), (snap) => callback(snap.exists() ? snap.val() : null));
    },

    watchMyRole({ code, uid }, callback) {
      return onValue(at("rooms", code, "roles", uid), (snap) => callback(snap.val() || null));
    },

    watchAllRoles(code, callback) {
      return onValue(at("rooms", code, "roles"), (snap) => callback(snap.val() || {}));
    },

    /* Watched, not read once: the team list can land after the role does, and a
       mafia player must never be left believing they work alone. */
    watchMafiaTeam(code, callback) {
      return onValue(at("rooms", code, "mafiaTeam"), (snap) => callback(snap.val() || []));
    },

    async dealRoles({ code, roles, mafiaTeam }) {
      // One atomic write: roles, the mafia roster, and the status flip together.
      await update(at("rooms", code), {
        roles,
        mafiaTeam,
        "meta/status": "dealt"
      });
    },

    async closeRoom(code) {
      await this.stopAutoLeave();
      await remove(at("rooms", code));
    }
  };
}
