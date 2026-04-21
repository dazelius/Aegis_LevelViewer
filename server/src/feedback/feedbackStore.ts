import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';

/**
 * Server-side persistent store for Aegisgram feedback.
 *
 * Feedback is an *online* artifact — multiple viewers hitting the same
 * scene must see each other's pins / posts — so we keep authoritative
 * state on the server and let every client fetch it over HTTP. The
 * client still has its own in-memory cache + pub-sub for smooth
 * rendering, but we treat the server copy as the source of truth.
 *
 * Storage format: a single JSON file (`<repoRoot>/data/feedbacks.json`)
 * holding `{ version, byScene }`. This is intentionally *not* a
 * database — the expected volume is small (tens to low thousands of
 * posts across an entire team lifetime), and shipping a SQLite/Postgres
 * dependency would dwarf the feature's value. Whole-file rewrite on
 * each mutation is fine at this scale; the atomic tmp-rename below
 * keeps the file consistent even on hard crashes.
 *
 * Thumbnails are stored inline as PNG data URLs. They dominate the
 * file size but keep the HTTP surface trivial (one GET, no blob
 * streaming). If the file ever grows uncomfortably large, the
 * migration path is obvious: bump `STORE_VERSION`, move thumbnails
 * into a sibling directory addressed by hash, and point the JSON at
 * relative paths.
 */

export interface FeedbackCameraPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
}

export interface FeedbackPlayerPose {
  position: [number, number, number];
  yaw: number;
}

/**
 * A single reply posted against a feedback. Stored flat on the
 * parent record — we don't need threaded replies at the scale we're
 * targeting, and keeping them inline means one GET hands the client
 * everything it needs to render the card. `id` is a client-generated
 * UUID: the comment endpoint is idempotent so a retry after a network
 * blip doesn't double-post.
 */
export interface FeedbackComment {
  id: string;
  author: string;
  text: string;
  createdAt: number;
}

/**
 * Review lifecycle for a feedback.
 *
 *   'open'     — fresh report nobody has acted on yet. This is the
 *                default when the composer POSTs a new pin.
 *   'resolved' — somebody has walked the level, looked at the pin,
 *                and marked it as "reviewed / acknowledged / no
 *                longer actionable". The UI dims resolved cards,
 *                swaps the pin icon to a green check, and lets
 *                filtering show only the open ones for the
 *                "what do I still need to answer?" loop.
 *
 * Kept as a string union (not a boolean) on purpose — when we add
 * intermediate states later ('in-progress', 'wontfix', …) we can
 * just extend the union without a storage migration.
 */
export type FeedbackStatus = 'open' | 'resolved';

export interface Feedback {
  id: string;
  scenePath: string;
  createdAt: number;
  text: string;
  anchor: [number, number, number];
  thumbnail: string;
  cameraPose: FeedbackCameraPose;
  playerPose: FeedbackPlayerPose;
  /** List of nicknames who clicked "like". Set semantics — each
   *  nickname appears at most once. Order is arbitrary but we keep
   *  insertion order so the UI can show "5 people liked this,
   *  including you" with `you` at a predictable spot. */
  likes: string[];
  comments: FeedbackComment[];
  /** Current review state. Defaults to 'open' for brand-new posts
   *  and for any pre-existing records on disk that predate this
   *  field — see `normalizeFeedback` below. */
  status: FeedbackStatus;
  /** When the status last transitioned to 'resolved'. `null` while
   *  the feedback is still open (including for records that were
   *  resolved then re-opened — re-opening clears the stamp so the
   *  UI doesn't show a stale "resolved 3 days ago" label on an
   *  active item). */
  resolvedAt: number | null;
  /** Nickname of whoever resolved it. Empty string while open. We
   *  keep the author handle, not an id, because everything else in
   *  this app identifies users by their self-chosen nickname. */
  resolvedBy: string;
}

export const STORE_VERSION = 1;

interface StoreDoc {
  version: number;
  byScene: Record<string, Feedback[]>;
}

const STORE_PATH = path.resolve(config.repoRoot, 'data', 'feedbacks.json');

let cache: StoreDoc | null = null;
let loadPromise: Promise<StoreDoc> | null = null;
let writeInFlight: Promise<void> | null = null;
let writeDirty = false;

/** Back-fill defaults for fields that older store files didn't know
 *  about. The likes/comments extension was additive, so pre-existing
 *  JSON on disk has neither key — we coerce them to empty arrays on
 *  read so the rest of the code can treat them as always-present.
 *  Kept pure (no mutation of the input) for easy reasoning. */
function normalizeFeedback(raw: unknown): Feedback | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.scenePath !== 'string') return null;
  const likes = Array.isArray(o.likes)
    ? (o.likes.filter((x) => typeof x === 'string' && x.trim()) as string[])
    : [];
  const commentsRaw = Array.isArray(o.comments) ? o.comments : [];
  const comments: FeedbackComment[] = [];
  for (const c of commentsRaw) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    if (
      typeof rec.id === 'string' &&
      typeof rec.author === 'string' &&
      typeof rec.text === 'string' &&
      typeof rec.createdAt === 'number' &&
      Number.isFinite(rec.createdAt)
    ) {
      comments.push({
        id: rec.id,
        author: rec.author,
        text: rec.text,
        createdAt: rec.createdAt,
      });
    }
  }
  // Status is additive over the original schema. Back-fill the
  // lifecycle fields so newer code can treat them as always-present.
  // Anything we don't recognise (typo, future value we don't support
  // yet) falls back to 'open' — the safe default is "still needs
  // attention", not "silently treat as resolved".
  const rawStatus = o.status;
  const status: FeedbackStatus = rawStatus === 'resolved' ? 'resolved' : 'open';
  const resolvedAt =
    typeof o.resolvedAt === 'number' && Number.isFinite(o.resolvedAt)
      ? o.resolvedAt
      : null;
  const resolvedBy = typeof o.resolvedBy === 'string' ? o.resolvedBy : '';
  return {
    ...(o as unknown as Feedback),
    likes,
    comments,
    status,
    // Keep the stamp consistent with the status: an 'open' record
    // with a non-null resolvedAt is nonsensical and would confuse
    // the UI's "resolved X ago" copy.
    resolvedAt: status === 'resolved' ? resolvedAt : null,
    resolvedBy: status === 'resolved' ? resolvedBy : '',
  };
}

async function loadFromDisk(): Promise<StoreDoc> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as StoreDoc;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === STORE_VERSION &&
      parsed.byScene &&
      typeof parsed.byScene === 'object'
    ) {
      // Normalise on load so callers never have to guard against the
      // pre-likes/comments shape.
      for (const [k, list] of Object.entries(parsed.byScene)) {
        if (!Array.isArray(list)) continue;
        parsed.byScene[k] = list
          .map(normalizeFeedback)
          .filter((x): x is Feedback => x !== null);
      }
      return parsed;
    }
    console.warn('[feedbackStore] schema mismatch, starting empty');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[feedbackStore] read failed, starting empty:', err);
    }
  }
  return { version: STORE_VERSION, byScene: {} };
}

async function ensureLoaded(): Promise<StoreDoc> {
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = loadFromDisk().then((doc) => {
      cache = doc;
      return doc;
    });
  }
  return loadPromise;
}

async function persistOnce(): Promise<void> {
  if (!cache) return;
  const dir = path.dirname(STORE_PATH);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache), 'utf8');
  await fs.rename(tmp, STORE_PATH);
}

/**
 * Queue a persist. If a write is already running, we flip a "dirty"
 * flag so the in-flight loop picks up any further mutations without
 * starting a second concurrent `writeFile`. Matches the standard
 * "coalesce rapid writes" pattern used by editor autosave.
 */
function schedulePersist(): void {
  writeDirty = true;
  if (writeInFlight) return;
  writeInFlight = (async () => {
    try {
      while (writeDirty) {
        writeDirty = false;
        await persistOnce();
      }
    } catch (err) {
      console.error('[feedbackStore] write failed:', err);
    }
  })().finally(() => {
    writeInFlight = null;
  });
}

/** Newest-first list for the given scene path. Never `null`; missing
 *  scenes return an empty array. Returned list is a fresh clone so
 *  callers can't accidentally mutate the in-memory cache. */
export async function listForScene(scenePath: string): Promise<Feedback[]> {
  const doc = await ensureLoaded();
  const list = doc.byScene[scenePath] ?? [];
  return list.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Flatten every feedback across every scene into a single
 * newest-first list. Powers the global "social feed" view — the
 * Instagram-style timeline that tells a reviewer at a glance what's
 * been happening across the whole map library.
 *
 * `limit` caps the number of entries returned so the feed page's
 * first paint stays fast even after months of accumulated posts.
 * Pagination (cursor / offset) can be added when any single team
 * actually hits the cap in anger — at current expected volumes
 * the first 200 rows easily span several days of activity.
 */
export async function listAll(limit = 200): Promise<Feedback[]> {
  const doc = await ensureLoaded();
  const all: Feedback[] = [];
  for (const list of Object.values(doc.byScene)) {
    for (const fb of list) all.push(fb);
  }
  all.sort((a, b) => b.createdAt - a.createdAt);
  if (limit > 0 && all.length > limit) all.length = limit;
  return all;
}

/** Upsert: if a feedback with the same id already exists, replace it.
 *  Makes retry-on-client-error idempotent and lets a future "edit
 *  feedback" feature reuse the same endpoint.
 *
 *  IMPORTANT: when a client re-submits the same id we keep the
 *  existing likes/comments — the compose path doesn't carry them,
 *  and overwriting would silently wipe every reaction. Social data
 *  lives behind its own dedicated endpoints (`toggleLike`, etc.). */
export async function upsertFeedback(fb: Feedback): Promise<void> {
  const doc = await ensureLoaded();
  const list = doc.byScene[fb.scenePath] ?? [];
  const idx = list.findIndex((x) => x.id === fb.id);
  if (idx >= 0) {
    const prev = list[idx];
    list[idx] = {
      ...fb,
      likes: prev.likes ?? [],
      comments: prev.comments ?? [],
      // Review lifecycle belongs to the dedicated `/status` endpoint
      // for exactly the same reason likes / comments do: the compose
      // path doesn't know the current state, and letting it overwrite
      // `resolved` with the default `open` every time somebody edits
      // a feedback would silently un-resolve items.
      status: prev.status ?? 'open',
      resolvedAt: prev.resolvedAt ?? null,
      resolvedBy: prev.resolvedBy ?? '',
    };
  } else {
    list.push({
      ...fb,
      likes: fb.likes ?? [],
      comments: fb.comments ?? [],
      status: fb.status ?? 'open',
      resolvedAt: fb.resolvedAt ?? null,
      resolvedBy: fb.resolvedBy ?? '',
    });
  }
  doc.byScene[fb.scenePath] = list;
  schedulePersist();
}

/** Find a feedback by scene + id, or `null` if either is unknown.
 *  Returns a direct reference into the cache — DO NOT mutate; the
 *  mutation helpers below build a new object and slot it back in via
 *  `upsertFeedback` so consumers always see immutable snapshots. */
async function findFeedback(
  scenePath: string,
  id: string,
): Promise<Feedback | null> {
  const doc = await ensureLoaded();
  const list = doc.byScene[scenePath];
  if (!list) return null;
  return list.find((x) => x.id === id) ?? null;
}

/**
 * Toggle a like for `nickname` on the given feedback. Returns the
 * updated record so the HTTP handler can reply with the authoritative
 * state (client uses it to reconcile its optimistic UI).
 *
 * Dedup keys are nickname strings. In a future world with real user
 * accounts this becomes a user id — the principle is the same.
 */
export async function toggleLike(
  scenePath: string,
  id: string,
  nickname: string,
): Promise<Feedback | null> {
  const name = nickname.trim();
  if (!name) return null;
  const fb = await findFeedback(scenePath, id);
  if (!fb) return null;
  const likes = fb.likes ?? [];
  const has = likes.includes(name);
  const nextLikes = has ? likes.filter((n) => n !== name) : [...likes, name];
  const updated: Feedback = { ...fb, likes: nextLikes };
  await upsertFeedbackAllowingReactions(updated);
  return updated;
}

/**
 * Append a comment. The comment id is client-supplied and used as an
 * idempotency key — if the same id already exists on the parent, we
 * return the existing state untouched. That way a client retry after
 * a network blip doesn't double-post the same reply.
 */
export async function addComment(
  scenePath: string,
  id: string,
  comment: FeedbackComment,
): Promise<Feedback | null> {
  const fb = await findFeedback(scenePath, id);
  if (!fb) return null;
  const comments = fb.comments ?? [];
  if (comments.some((c) => c.id === comment.id)) {
    return fb;
  }
  const nextComments = [...comments, comment];
  const updated: Feedback = { ...fb, comments: nextComments };
  await upsertFeedbackAllowingReactions(updated);
  return updated;
}

/** Remove a comment by id. No-op (returns current record) if the
 *  id isn't present — lets the client treat 200 as "row is gone"
 *  without a fussy 404 dance. */
export async function removeComment(
  scenePath: string,
  id: string,
  commentId: string,
): Promise<Feedback | null> {
  const fb = await findFeedback(scenePath, id);
  if (!fb) return null;
  const comments = fb.comments ?? [];
  const nextComments = comments.filter((c) => c.id !== commentId);
  if (nextComments.length === comments.length) return fb;
  const updated: Feedback = { ...fb, comments: nextComments };
  await upsertFeedbackAllowingReactions(updated);
  return updated;
}

/**
 * Flip a feedback's review status. `nickname` is the actor — stamped
 * on the record when marking resolved so the UI can show "resolved
 * by Alice 5 min ago", and cleared when re-opening so a stale label
 * doesn't hang around on an item that's back in play.
 *
 * Returns the updated record so the HTTP handler can echo the
 * authoritative state back to the caller for optimistic UI
 * reconciliation (same pattern as `toggleLike` / `addComment`).
 * Returns the unchanged record if the requested status already
 * matches — callers can treat "no-op" as success, no fussy 304 needed.
 */
export async function setStatus(
  scenePath: string,
  id: string,
  status: FeedbackStatus,
  nickname: string,
): Promise<Feedback | null> {
  const fb = await findFeedback(scenePath, id);
  if (!fb) return null;
  if ((fb.status ?? 'open') === status) return fb;
  const actor = nickname.trim();
  const updated: Feedback =
    status === 'resolved'
      ? {
          ...fb,
          status,
          resolvedAt: Date.now(),
          resolvedBy: actor || fb.resolvedBy || '',
        }
      : { ...fb, status, resolvedAt: null, resolvedBy: '' };
  await upsertFeedbackAllowingReactions(updated);
  return updated;
}

/** Internal upsert that PRESERVES the caller-supplied reactions —
 *  used by the like/comment helpers where the caller has already
 *  built the authoritative next state and must not be overridden by
 *  the "keep previous reactions" rule `upsertFeedback` applies to
 *  composer submissions. */
async function upsertFeedbackAllowingReactions(fb: Feedback): Promise<void> {
  const doc = await ensureLoaded();
  const list = doc.byScene[fb.scenePath] ?? [];
  const idx = list.findIndex((x) => x.id === fb.id);
  if (idx >= 0) list[idx] = fb;
  else list.push(fb);
  doc.byScene[fb.scenePath] = list;
  schedulePersist();
}

/** Returns `true` if a record was removed, `false` if nothing matched
 *  (unknown scene or id). Callers can surface the difference as a 404. */
export async function removeFeedback(scenePath: string, id: string): Promise<boolean> {
  const doc = await ensureLoaded();
  const list = doc.byScene[scenePath];
  if (!list) return false;
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return false;
  doc.byScene[scenePath] = next;
  schedulePersist();
  return true;
}

/** Total count across all scenes. Diagnostic only — used by the
 *  `/api/health`-style endpoint and the occasional startup log. */
export async function totalCount(): Promise<number> {
  const doc = await ensureLoaded();
  let n = 0;
  for (const list of Object.values(doc.byScene)) n += list.length;
  return n;
}

/** Shape validation. We validate at the HTTP boundary so garbage
 *  client payloads can't corrupt the JSON file and break every
 *  subsequent GET. `likes` / `comments` are optional — the composer
 *  path submits new records without reactions, and back-filling them
 *  via `upsertFeedback` is the store's responsibility. */
export function isFeedback(x: unknown): x is Feedback {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return false;
  if (typeof o.scenePath !== 'string' || !o.scenePath) return false;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return false;
  if (typeof o.text !== 'string') return false;
  if (typeof o.thumbnail !== 'string') return false;
  if (!Array.isArray(o.anchor) || o.anchor.length !== 3) return false;
  if (!o.cameraPose || typeof o.cameraPose !== 'object') return false;
  if (!o.playerPose || typeof o.playerPose !== 'object') return false;
  return true;
}

/** Comment text / author validation shared by the HTTP handler. A
 *  comment with no text is silently dropped rather than rejected —
 *  users tend to accidentally hit Enter and there's no meaningful
 *  signal in "400 bad request" for that case. */
export const COMMENT_TEXT_MAX = 500;
export function sanitizeCommentText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, COMMENT_TEXT_MAX);
}
export function sanitizeAuthor(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
}
