/**
 * Pure role logic — no DOM, no network.
 * Shared by both the one-device mode and the online mode.
 */

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 20;
export const DOCTORS = 1;

export const ROLES = {
  mafia: {
    label: "Mafia",
    emoji: "\u{1F52A}",
    desc: "Wake at night with your team and choose someone to eliminate. Blend in during the day."
  },
  doctor: {
    label: "Doctor",
    emoji: "\u{1F489}",
    desc: "Each night, pick one player to save. Guess right and the mafia's kill fails."
  },
  civilian: {
    label: "Civilian",
    emoji: "\u{1F464}",
    desc: "You have no night power. Watch, argue, and vote the mafia out before they outnumber you."
  }
};

/** Unbiased random integer in [0, maxExclusive). */
export function randomInt(maxExclusive) {
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit); // reject the tail so every outcome stays equally likely
  return value % maxExclusive;
}

/** Fisher-Yates, in place. */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const suggestedMafia = (playerCount) => (playerCount >= 7 ? 2 : 1);

export const civiliansFor = (playerCount, mafiaCount) => playerCount - mafiaCount - DOCTORS;

/** A shuffled array of role keys, one per player. */
export function buildRolePool(playerCount, mafiaCount) {
  const pool = [];
  for (let i = 0; i < mafiaCount; i++) pool.push("mafia");
  for (let i = 0; i < DOCTORS; i++) pool.push("doctor");
  while (pool.length < playerCount) pool.push("civilian");
  return shuffle(pool);
}

/** Room codes: no I/O/0/1, so nobody misreads them out loud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function makeRoomCode(length = 4) {
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}
