/**
 * In-browser feedback store.
 *
 * M1 needs a persistent record of per-scene feedback so the "mark
 * this wall is weird → come back tomorrow and see the pin" loop
 * works even without a backend. We keep feedbacks in `localStorage`
 * keyed by scene path and surface a small pub-sub API so pins +
 * panel components re-render when the list changes.
 *
 * Stored shape is `Feedback[]` per scene. The whole list rewrites on
 * every mutation — fine for the tens-to-hundreds scale this feature
 * will see before we promote it to a server endpoint. Thumbnails are
 * inline data-URLs, which dominates the storage size; the list would
 * have to get into the tens of thousands before localStorage's 5 MB
 * ceiling starts to bite. A future server port can stream these to
 * IndexedDB / the backend and shrink each record to just a URL +
 * metadata.
 *
 * Schema versioning: `STORE_VERSION` is bumped when the Feedback
 * shape changes incompatibly. Old payloads are discarded on read —
 * we'd rather lose local-only feedback than render with stale keys
 * and confuse the user.
 */

export const STORE_VERSION = 1;

export interface FeedbackCameraPose {
  /** Three.js world-space camera position (right-handed). */
  position: [number, number, number];
  /** Camera world-space quaternion, order (x, y, z, w). Enough to
   *  restore the view direction exactly on "revisit". */
  quaternion: [number, number, number, number];
  /** Camera FOV (vertical, degrees) at capture time, because we
   *  support preset swaps that change FOV (Stand → Aim). A revisit
   *  that puts the user back at the same position but at Hip FOV
   *  would show a wider frame than the thumbnail. */
  fov: number;
}

export interface FeedbackPlayerPose {
  position: [number, number, number];
  yaw: number;
}

export interface Feedback {
  /** Random UUID-ish id. Used as list key + for pin picking. */
  id: string;
  /** Relative scene path, mirroring the URL. A feedback belongs to
   *  exactly one scene; switching scenes filters the visible list. */
  scenePath: string;
  /** Epoch milliseconds, captured at submit time (NOT compose time).
   *  Shown in the feed list / pin tooltip. */
  createdAt: number;
  /** User-authored body text. May be empty — "just drop a pin here"
   *  is a valid usage (e.g. bookmarking a vista). */
  text: string;
  /** World-space anchor (three.js RH, Y-up metres). Where the pin
   *  renders in the scene. Populated from the crosshair raycast at
   *  capture time; the composer refuses to open unless the raycast
   *  hit real geometry (`playModeState.aimValid`). */
  anchor: [number, number, number];
  /** PNG data-URL of the canvas at capture time. Typically 80–200 KB
   *  depending on scene complexity and canvas size. Rendered inline
   *  in the feed list + composer preview. */
  thumbnail: string;
  /** Camera pose at capture — lets a future "jump to this view"
   *  feature restore the exact frame in one click. */
  cameraPose: FeedbackCameraPose;
  /** Player pose at capture. Useful for "walk to where I was
   *  standing" (M4) before rotating to match `cameraPose`. */
  playerPose: FeedbackPlayerPose;
}

interface StoreDoc {
  version: number;
  byScene: Record<string, Feedback[]>;
}

const LS_KEY = 'aegis.feedbacks.v1';

function readAll(): StoreDoc {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { version: STORE_VERSION, byScene: {} };
    const parsed = JSON.parse(raw) as StoreDoc;
    if (!parsed || parsed.version !== STORE_VERSION || typeof parsed.byScene !== 'object') {
      return { version: STORE_VERSION, byScene: {} };
    }
    return parsed;
  } catch {
    return { version: STORE_VERSION, byScene: {} };
  }
}

function writeAll(doc: StoreDoc): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(doc));
  } catch (err) {
    // Most likely QuotaExceededError — thumbnails grew past the
    // 5 MB cap. Surface to the console so a user with hundreds of
    // feedbacks sees why a submit silently "worked" but is gone on
    // reload. No UI toast yet; that lives in the composer layer.
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] localStorage write failed:', err);
  }
}

type Subscriber = () => void;
const subscribers = new Set<Subscriber>();

function notify(): void {
  for (const fn of subscribers) fn();
}

export function subscribeFeedbacks(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Newest-first list for the given scene. Cheap to call on every
 *  render — localStorage parse is microseconds at this scale. */
export function listFeedbacks(scenePath: string): Feedback[] {
  const doc = readAll();
  const list = doc.byScene[scenePath] ?? [];
  // Clone so callers can't mutate our in-memory copy and confuse
  // React's render diffing.
  return list.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function addFeedback(fb: Feedback): void {
  const doc = readAll();
  const list = doc.byScene[fb.scenePath] ?? [];
  list.push(fb);
  doc.byScene[fb.scenePath] = list;
  writeAll(doc);
  notify();
}

export function removeFeedback(scenePath: string, id: string): void {
  const doc = readAll();
  const list = doc.byScene[scenePath];
  if (!list) return;
  const next = list.filter((fb) => fb.id !== id);
  if (next.length === list.length) return;
  doc.byScene[scenePath] = next;
  writeAll(doc);
  notify();
}

/** crypto.randomUUID is available in every browser we support, but
 *  guard anyway so old test envs (jsdom without the polyfill) don't
 *  crash the composer. The fallback is not cryptographically
 *  unique, but collision within a single user's local store is
 *  astronomically unlikely. */
export function makeFeedbackId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}
