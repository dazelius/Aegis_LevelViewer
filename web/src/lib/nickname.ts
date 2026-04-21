/**
 * Local identity for the multiplayer hub.
 *
 * Aegisgram doesn't have user accounts yet — for the MVP we just
 * let each browser pick a nickname, stored in `localStorage` so the
 * same person returning tomorrow shows up under the same name. The
 * first visit generates a random "Guest-xxxx" handle the user can
 * edit from the header at any time.
 *
 * All subscribers are notified synchronously when the nickname
 * changes so WS `hello` messages can re-announce the new name and
 * existing remote-player labels can re-render without the whole
 * app having to be React-context aware.
 */

const LS_KEY = 'aegisgram.nickname';
const MAX_LEN = 24;

type Subscriber = (next: string) => void;
const subs = new Set<Subscriber>();

let current = loadOrGenerate();

function loadOrGenerate(): string {
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored && stored.trim()) return sanitize(stored);
  } catch {
    // localStorage may be disabled (private mode). Fall through.
  }
  const gen = `Guest-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
  try {
    localStorage.setItem(LS_KEY, gen);
  } catch {
    // ignore — memory-only nickname is fine
  }
  return gen;
}

/** Strip control chars, collapse whitespace, clamp to `MAX_LEN`. */
function sanitize(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, MAX_LEN) || 'Guest';
}

export function getNickname(): string {
  return current;
}

export function setNickname(next: string): void {
  const clean = sanitize(next);
  if (clean === current) return;
  current = clean;
  try {
    localStorage.setItem(LS_KEY, clean);
  } catch {
    // ignore
  }
  for (const fn of subs) fn(clean);
}

export function subscribeNickname(fn: Subscriber): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
