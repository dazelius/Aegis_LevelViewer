import { useEffect, useState } from 'react';

import { subscribeHoveredFeedback, getHoveredFeedbackId } from './feedbackHover';
import {
  listFeedbacks,
  subscribeFeedbacks,
  type Feedback,
} from './feedbackStore';

/**
 * Floating preview card that appears when the player's crosshair
 * lands on a feedback pin. Pinned just below the screen centre so
 * the reticle itself stays unobstructed — this is the "aim at the
 * pin, see the feed" loop the user asked for.
 *
 * Subscribes to two streams:
 *   1. `feedbackHover` — writes the currently hovered pin id every
 *      frame from inside the R3F Canvas (`FeedbackPinHoverProbe`).
 *   2. `feedbackStore` — authoritative feedback list for the scene,
 *      scene-scoped by `scenePath`.
 *
 * We don't need a stable ordering or any of the panel's grouping
 * logic — the tooltip only ever shows ONE feedback at a time (the
 * hovered one), so a flat id-lookup over the current scene's cache
 * is enough. On cache refresh we re-resolve the id; if the pin was
 * deleted by another client while the user was hovering, the card
 * simply vanishes.
 *
 * Rendering is DOM (not R3F) so it gets normal HTML text layout,
 * anti-aliased fonts, and doesn't have to fight with the Canvas
 * render order for the thumbnail image.
 */
export function FeedbackTooltip({ scenePath }: { scenePath: string }) {
  const [hoverId, setHoverId] = useState<string | null>(() =>
    getHoveredFeedbackId(),
  );
  // Local mirror of the scene's feedback cache. We re-read from
  // `listFeedbacks` on every store update (cheap: it's a sorted
  // in-memory array) so a newly-added or deleted pin reflects in
  // the tooltip without a round-trip.
  const [cache, setCache] = useState<Feedback[]>(() =>
    listFeedbacks(scenePath),
  );

  useEffect(() => {
    setHoverId(getHoveredFeedbackId());
    const unsubHover = subscribeHoveredFeedback(() =>
      setHoverId(getHoveredFeedbackId()),
    );
    return unsubHover;
  }, []);

  useEffect(() => {
    setCache(listFeedbacks(scenePath));
    const unsubStore = subscribeFeedbacks(() =>
      setCache(listFeedbacks(scenePath)),
    );
    return unsubStore;
  }, [scenePath]);

  // Resolve the hovered id against the cache. `null` → nothing
  // hovered; `undefined` → hovered id is stale (pin was deleted
  // out from under us); either way, render nothing.
  const fb = hoverId ? cache.find((x) => x.id === hoverId) ?? null : null;

  const resolved = fb?.status === 'resolved';

  return (
    <div
      className={`feedback-tooltip${fb ? ' is-visible' : ''}${resolved ? ' is-resolved' : ''}`}
      role="status"
      aria-hidden={!fb}
    >
      {fb && (
        <>
          {fb.thumbnail && (
            <img
              className="feedback-tooltip-thumb"
              src={fb.thumbnail}
              alt=""
            />
          )}
          <div className="feedback-tooltip-body">
            <div className="feedback-tooltip-meta">
              {/*
                Status pill in the tooltip mirrors the same badge we
                show everywhere else (panel, feed, 3D pin colour) so
                the mental model is consistent: one look at the
                crosshair tells you whether the pin still needs
                attention or not.
              */}
              <span
                className={`feedback-status-badge${resolved ? ' is-resolved' : ' is-open'}`}
              >
                <span aria-hidden="true">{resolved ? '✓' : '●'}</span>
                {resolved ? '확인됨' : '확인중'}
              </span>
              <span className="feedback-tooltip-time">{formatTime(fb.createdAt)}</span>
            </div>
            <div className="feedback-tooltip-text">{fb.text || '(내용 없음)'}</div>
            {(fb.likes.length > 0 || fb.comments.length > 0) && (
              <div className="feedback-tooltip-reactions">
                <span className="feedback-tooltip-reaction">
                  <span aria-hidden="true">♥</span> {fb.likes.length}
                </span>
                <span className="feedback-tooltip-reaction">
                  <span aria-hidden="true">💬</span> {fb.comments.length}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "방금", "3 분 전", "어제", "12월 3일 14:22" — the same kind of
 * relative/absolute hybrid you'd see on Twitter or KakaoTalk. Keeps
 * the tooltip glanceable: the player's reading it in half a second
 * before moving on.
 */
function formatTime(epochMs: number): string {
  const d = Date.now() - epochMs;
  if (d < 60_000) return '방금';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}일 전`;
  const dt = new Date(epochMs);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `${mm}.${dd} ${hh}:${mi}`;
}
