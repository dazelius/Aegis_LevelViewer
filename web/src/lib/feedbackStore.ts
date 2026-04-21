/**
 * Client-side feedback cache + server API wrapper.
 *
 * Source of truth is the server (`/api/feedbacks`). The client keeps
 * an in-memory cache per scene so React render stays synchronous —
 * `listFeedbacks(scenePath)` returns whatever is cached right now
 * without hitting the network, and callers subscribe via
 * `subscribeFeedbacks` to be notified when the cache updates.
 *
 * Mutations (`addFeedback`, `removeFeedback`) go out to the server
 * first and update the cache from the server's response, so two
 * clients in the same scene converge on the same list whenever one
 * of them POSTs a new pin. A `pollFeedbacks` helper lets a component
 * re-fetch periodically while the scene is mounted — current UI
 * polls every ~15 s, cheap enough since the GET hits an in-memory
 * cache on the server side.
 *
 * Offline fallback: if the server is unreachable, writes still
 * succeed locally (cached in memory, mirrored to `localStorage` so
 * they survive reloads). The next successful refresh replaces the
 * local list with the server's version — in practice this means
 * offline posts are transient until the server comes back, which is
 * the right behaviour for a tool with no user accounts yet (attempting
 * to "sync" offline writes to an authoritative shared store without
 * knowing who authored them would merge identity across users).
 */

import { apiUrl } from './api';

export const STORE_VERSION = 1;

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
 * Individual reply against a feedback. Flat (not threaded) — the
 * team-scale volume doesn't warrant a parent-child tree, and a flat
 * list keeps the card rendering simple. `id` is a client-generated
 * UUID used by the server as an idempotency key.
 */
export interface FeedbackComment {
  id: string;
  author: string;
  text: string;
  createdAt: number;
}

/**
 * Review lifecycle (mirrors the server enum).
 *
 *   'open'     — newly posted, still needs attention.
 *   'resolved' — somebody walked the level, looked at the pin, and
 *                marked it handled. The UI dims these cards, swaps
 *                the 3D pin to a green checkmark, and lets filters
 *                show just the open ones.
 *
 * Intentionally a string union so future states ('in-progress',
 * 'wontfix', …) can slot in without a data migration.
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
  /** Nicknames of everyone who hit "like". Stored as a list because
   *  we want to show WHO liked as well as the count. */
  likes: string[];
  comments: FeedbackComment[];
  /** Review state. Defaults to 'open' for brand-new / legacy records. */
  status: FeedbackStatus;
  /** Epoch ms of the latest open → resolved transition. `null` while
   *  the feedback is open (including after a re-open; the stamp is
   *  cleared so a stale "resolved X ago" label can't linger). */
  resolvedAt: number | null;
  /** Nickname of whoever marked it resolved. Empty while open. */
  resolvedBy: string;
}

/** Coerce a possibly-partial record (older localStorage mirrors,
 *  server payloads pre-likes/comments) into the full shape. */
function normalizeFeedback(raw: Partial<Feedback> & Feedback): Feedback {
  // Status is additive. Anything we don't recognise — an older
  // localStorage mirror without the field, a string we don't support
  // yet — falls back to 'open' (the safe "still needs attention"
  // default) and we clear the resolution stamp to keep it
  // consistent with the status.
  const status: FeedbackStatus = raw.status === 'resolved' ? 'resolved' : 'open';
  const resolvedAt =
    status === 'resolved' && typeof raw.resolvedAt === 'number'
      ? raw.resolvedAt
      : null;
  const resolvedBy =
    status === 'resolved' && typeof raw.resolvedBy === 'string' ? raw.resolvedBy : '';
  return {
    ...raw,
    likes: Array.isArray(raw.likes) ? raw.likes.slice() : [],
    comments: Array.isArray(raw.comments) ? raw.comments.slice() : [],
    status,
    resolvedAt,
    resolvedBy,
  };
}

// ---------------------------------------------------------------------
// In-memory cache + subscription
// ---------------------------------------------------------------------

/** `scenePath → newest-first list`. Updated whenever the server
 *  returns a new snapshot, or an optimistic local mutation lands. */
const cache = new Map<string, Feedback[]>();

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

/** Synchronous read of the current cached list for a scene, newest-first.
 *  Returns an empty array for scenes we haven't refreshed yet — the
 *  first `refreshFeedbacks` call will populate it and fire subscribers. */
export function listFeedbacks(scenePath: string): Feedback[] {
  const list = cache.get(scenePath) ?? [];
  return list.slice();
}

function setCacheForScene(scenePath: string, list: Feedback[]): void {
  const sorted = list
    .map(normalizeFeedback)
    .sort((a, b) => b.createdAt - a.createdAt);
  cache.set(scenePath, sorted);
  mirrorToLocalStorage();
  notify();
}

/** Replace a single entry in a scene's cache without touching the
 *  others (no re-sort needed: createdAt doesn't change on likes /
 *  comments). Used by the realtime bridge for in-place mutations. */
function patchCacheEntry(scenePath: string, updated: Feedback): void {
  const list = cache.get(scenePath);
  if (!list) return;
  const idx = list.findIndex((x) => x.id === updated.id);
  if (idx < 0) return;
  const next = list.slice();
  next[idx] = normalizeFeedback(updated);
  cache.set(scenePath, next);
  mirrorToLocalStorage();
  notify();
}

// ---------------------------------------------------------------------
// localStorage mirror (best-effort offline cache)
// ---------------------------------------------------------------------

const LS_KEY = 'aegisgram.feedbacks.cache.v1';

interface LocalMirror {
  version: number;
  byScene: Record<string, Feedback[]>;
}

function mirrorToLocalStorage(): void {
  try {
    const doc: LocalMirror = { version: STORE_VERSION, byScene: {} };
    for (const [k, v] of cache.entries()) doc.byScene[k] = v;
    localStorage.setItem(LS_KEY, JSON.stringify(doc));
  } catch (err) {
    // QuotaExceededError most likely — cache got too big with
    // thumbnail data URLs. Non-fatal: the network path is still
    // authoritative, we only lose the offline mirror.
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] localStorage mirror write failed:', err);
  }
}

/** Re-hydrate the in-memory cache from localStorage on module load.
 *  Gives us something to render in the first paint before the server
 *  fetch settles, and provides fallback data when the server is
 *  unreachable. Called once, at import time. */
function hydrateFromLocalStorage(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const doc = JSON.parse(raw) as LocalMirror;
    if (!doc || doc.version !== STORE_VERSION || !doc.byScene) return;
    for (const [k, v] of Object.entries(doc.byScene)) {
      if (Array.isArray(v)) cache.set(k, v.map(normalizeFeedback));
    }
  } catch {
    // Corrupt cache — ignore, will be overwritten on first server round-trip.
  }
}
hydrateFromLocalStorage();

// ---------------------------------------------------------------------
// Server API
// ---------------------------------------------------------------------

/** Fetch the server's view of the feedbacks for a scene and update
 *  the cache. Returns the fresh list (already in newest-first order).
 *  Silent on network failure — the cache keeps whatever it had. */
export async function refreshFeedbacks(scenePath: string): Promise<Feedback[] | null> {
  try {
    const res = await fetch(apiUrl(`/api/feedbacks?scenePath=${encodeURIComponent(scenePath)}`));
    if (!res.ok) throw new Error(`GET /api/feedbacks ${res.status}`);
    const body = (await res.json()) as { feedbacks?: Feedback[] };
    const list = Array.isArray(body.feedbacks) ? body.feedbacks : [];
    setCacheForScene(scenePath, list);
    return cache.get(scenePath) ?? [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] refresh failed:', err);
    return null;
  }
}

/** POST a new (or updated) feedback. On success the server's copy
 *  wins — we re-fetch and replace the cache so optimistic entries
 *  converge with the authoritative list. Optimistic insert keeps
 *  the UI snappy on the author's side even before the POST lands. */
export async function addFeedback(fb: Feedback): Promise<void> {
  const withDefaults = normalizeFeedback(fb);
  const current = cache.get(fb.scenePath) ?? [];
  const nextLocal = [...current.filter((x) => x.id !== fb.id), withDefaults];
  setCacheForScene(fb.scenePath, nextLocal);
  try {
    const res = await fetch(apiUrl('/api/feedbacks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withDefaults),
    });
    if (!res.ok) throw new Error(`POST /api/feedbacks ${res.status}`);
    // Re-sync with server so we pick up any concurrent posts from
    // other viewers in the same scene.
    await refreshFeedbacks(fb.scenePath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] add failed, keeping optimistic local copy:', err);
  }
}

// ---------------------------------------------------------------------
// Reaction mutations (likes / comments)
// ---------------------------------------------------------------------
//
// Each helper does an optimistic local mutation so the UI can update
// instantly, then posts to the server. On success we merge the
// authoritative response back into the cache — this is cheap
// insurance against server-side sanitisation (e.g. the server might
// trim whitespace in a comment text that our optimistic copy kept).
// On failure we log but keep the optimistic state; the next refresh
// or realtime event will reconcile.

/**
 * Toggle a like for `nickname` on `id`. Dedupes on nickname, so
 * clicking twice removes the like.
 */
export async function toggleLike(
  scenePath: string,
  id: string,
  nickname: string,
): Promise<void> {
  const list = cache.get(scenePath);
  const existing = list?.find((x) => x.id === id);
  if (existing) {
    const hasLike = existing.likes.includes(nickname);
    const nextLikes = hasLike
      ? existing.likes.filter((n) => n !== nickname)
      : [...existing.likes, nickname];
    patchCacheEntry(scenePath, { ...existing, likes: nextLikes });
  }
  try {
    const res = await fetch(apiUrl(`/api/feedbacks/${encodeURIComponent(id)}/like`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenePath, nickname }),
    });
    if (!res.ok) throw new Error(`POST like ${res.status}`);
    const body = (await res.json()) as { feedback?: Feedback };
    if (body.feedback) patchCacheEntry(scenePath, body.feedback);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] toggleLike failed:', err);
  }
}

/**
 * Append a comment. The comment id is generated client-side so an
 * optimistic entry has a stable identity — the server treats that
 * same id as an idempotency key, and the response's comment array
 * will contain it exactly once regardless of retries.
 */
export async function addComment(
  scenePath: string,
  id: string,
  author: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const commentId = makeFeedbackId();
  const nowTs = Date.now();
  const list = cache.get(scenePath);
  const existing = list?.find((x) => x.id === id);
  if (existing) {
    patchCacheEntry(scenePath, {
      ...existing,
      comments: [
        ...existing.comments,
        { id: commentId, author, text: trimmed, createdAt: nowTs },
      ],
    });
  }
  try {
    const res = await fetch(apiUrl(`/api/feedbacks/${encodeURIComponent(id)}/comment`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenePath, commentId, author, text: trimmed }),
    });
    if (!res.ok) throw new Error(`POST comment ${res.status}`);
    const body = (await res.json()) as { feedback?: Feedback };
    if (body.feedback) patchCacheEntry(scenePath, body.feedback);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] addComment failed:', err);
  }
}

/** Remove a comment. The UI should only surface the delete action
 *  to the comment's author, but we don't enforce that server-side:
 *  this is a trusted-internal tool and guardrails would cost more
 *  in friction than they prevent. */
export async function removeFeedbackComment(
  scenePath: string,
  id: string,
  commentId: string,
): Promise<void> {
  const list = cache.get(scenePath);
  const existing = list?.find((x) => x.id === id);
  if (existing) {
    patchCacheEntry(scenePath, {
      ...existing,
      comments: existing.comments.filter((c) => c.id !== commentId),
    });
  }
  try {
    const res = await fetch(
      apiUrl(
        `/api/feedbacks/${encodeURIComponent(id)}/comment/${encodeURIComponent(commentId)}?scenePath=${encodeURIComponent(scenePath)}`,
      ),
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`DELETE comment ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as { feedback?: Feedback } | null;
    if (body?.feedback) patchCacheEntry(scenePath, body.feedback);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] removeFeedbackComment failed:', err);
  }
}

/**
 * Flip review status on a feedback. Marking resolved stamps
 * `resolvedAt` / `resolvedBy` with the caller's nickname / now;
 * re-opening clears them so the UI never shows a stale resolution
 * label on an item that's back in play.
 *
 * Same optimistic-then-reconcile pattern as the other social
 * mutations: flip the cache immediately so the pin colour / badge
 * update feels instant, then POST and merge the authoritative
 * response.
 */
export async function setFeedbackStatus(
  scenePath: string,
  id: string,
  status: FeedbackStatus,
  nickname: string,
): Promise<void> {
  const list = cache.get(scenePath);
  const existing = list?.find((x) => x.id === id);
  if (existing && existing.status !== status) {
    const optimistic: Feedback =
      status === 'resolved'
        ? {
            ...existing,
            status,
            resolvedAt: Date.now(),
            resolvedBy: nickname,
          }
        : { ...existing, status, resolvedAt: null, resolvedBy: '' };
    patchCacheEntry(scenePath, optimistic);
  }
  try {
    const res = await fetch(
      apiUrl(`/api/feedbacks/${encodeURIComponent(id)}/status`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenePath, status, nickname }),
      },
    );
    if (!res.ok) throw new Error(`POST status ${res.status}`);
    const body = (await res.json()) as { feedback?: Feedback };
    if (body.feedback) patchCacheEntry(scenePath, body.feedback);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] setFeedbackStatus failed:', err);
  }
}

/** Remove a feedback by id. Optimistic local removal; server DELETE
 *  is fire-and-report-failure. */
export async function removeFeedback(scenePath: string, id: string): Promise<void> {
  const current = cache.get(scenePath) ?? [];
  const next = current.filter((x) => x.id !== id);
  if (next.length !== current.length) setCacheForScene(scenePath, next);
  try {
    const res = await fetch(
      apiUrl(`/api/feedbacks?scenePath=${encodeURIComponent(scenePath)}&id=${encodeURIComponent(id)}`),
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`DELETE /api/feedbacks ${res.status}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[feedbackStore] remove failed, keeping optimistic local removal:', err);
  }
}

/**
 * Fetch the flattened, newest-first list of every feedback across
 * every scene. Powers the global social feed page (`/feed`) — no
 * in-memory cache here because the feed is its own view and the
 * per-scene cache wouldn't help a "what happened across all maps"
 * query.
 *
 * `limit` defaults to 200 (server-enforced max 1000). The page
 * re-fetches on mount + on an interval, so staleness is bounded
 * by the poll cadence rather than requiring manual refresh.
 */
export async function fetchAllFeedbacks(limit = 200): Promise<Feedback[]> {
  const res = await fetch(apiUrl(`/api/feedbacks/all?limit=${encodeURIComponent(String(limit))}`));
  if (!res.ok) throw new Error(`GET /api/feedbacks/all ${res.status}`);
  const body = (await res.json()) as { feedbacks?: Feedback[] };
  const list = Array.isArray(body.feedbacks) ? body.feedbacks : [];
  // Seed the per-scene caches with what we just fetched. The feed
  // page renders shared `<FeedbackReactions>` components that pull
  // their "live" state from these caches so optimistic like /
  // comment mutations flip the UI instantly — without seeding, a
  // user on the feed page would see their own likes only after the
  // WS echo round-tripped the server. We group by scenePath and
  // merge into any existing cache so we never stomp a scene that's
  // already been loaded fresher via `refreshFeedbacks`.
  const byScene = new Map<string, Feedback[]>();
  for (const fb of list) {
    let bucket = byScene.get(fb.scenePath);
    if (!bucket) {
      bucket = [];
      byScene.set(fb.scenePath, bucket);
    }
    bucket.push(normalizeFeedback(fb));
  }
  for (const [scenePath, fresh] of byScene.entries()) {
    const existing = cache.get(scenePath) ?? [];
    // Merge strategy: server copy wins for any id that appears in
    // the feed response, because that's the authoritative snapshot
    // we just pulled; keep any local-only entries that weren't in
    // this response (edge case: entries newer than the feed's limit
    // window).
    const seen = new Set(fresh.map((x) => x.id));
    const merged = [
      ...fresh,
      ...existing.filter((x) => !seen.has(x.id)),
    ];
    setCacheForScene(scenePath, merged);
  }
  return list;
}

/** Start a polling loop that re-fetches feedbacks at `intervalMs`.
 *  Returns a cleanup fn; call it on unmount. Fires an immediate
 *  refresh so the first render has up-to-date data. */
export function pollFeedbacks(scenePath: string, intervalMs = 15000): () => void {
  let cancelled = false;
  void refreshFeedbacks(scenePath);
  const handle = setInterval(() => {
    if (cancelled) return;
    void refreshFeedbacks(scenePath);
  }, intervalMs);
  return () => {
    cancelled = true;
    clearInterval(handle);
  };
}

// ---------------------------------------------------------------------
// Realtime bridge (multiplayer hub → cache)
// ---------------------------------------------------------------------
//
// Whenever the multiplayer hub tells us somebody posted or deleted a
// feedback, we apply the change to our in-memory cache immediately so
// pins, the side panel, and the global feed update without waiting
// for the next 15 s poll tick. Wired lazily from the hub side (via
// dynamic import) to avoid a circular dep at module load time — the
// hub wants to reference `Feedback` from this file for its own
// protocol types, and a straight import back would have them load
// each other in an order Vite doesn't like.
//
// The function is exported so `multiplayer.ts` can call into it via
// a regular import; no lazy trick needed.

/** Apply a server-pushed add/update/remove event to the local cache. */
export function applyServerFeedbackEvent(
  ev:
    | { type: 'added'; feedback: Feedback }
    | { type: 'updated'; feedback: Feedback }
    | { type: 'removed'; scenePath: string; id: string },
): void {
  if (ev.type === 'added') {
    const list = cache.get(ev.feedback.scenePath) ?? [];
    const next = [...list.filter((x) => x.id !== ev.feedback.id), ev.feedback];
    setCacheForScene(ev.feedback.scenePath, next);
    return;
  }
  if (ev.type === 'updated') {
    // In-place replacement. No reorder: updates don't change
    // createdAt, so the newest-first sort is already correct.
    patchCacheEntry(ev.feedback.scenePath, ev.feedback);
    return;
  }
  // removed
  const list = cache.get(ev.scenePath);
  if (!list) return;
  const next = list.filter((x) => x.id !== ev.id);
  if (next.length === list.length) return;
  setCacheForScene(ev.scenePath, next);
}

// ---------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------

/** crypto.randomUUID is available in every browser we support, but
 *  guard anyway so old test envs (jsdom without the polyfill) don't
 *  crash the composer. The fallback is not cryptographically unique,
 *  but collision within a single user's session is astronomically
 *  unlikely. */
export function makeFeedbackId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}
