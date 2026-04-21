import { useEffect, useRef, useState } from 'react';

import {
  getBubbleProjection,
  isShowAllActive,
  subscribeShowAll,
} from './feedbackBubbles';
import {
  listFeedbacks,
  subscribeFeedbacks,
  type Feedback,
} from './feedbackStore';

/**
 * "Show every feedback at once" overlay — the payoff for the V key.
 *
 * Renders one floating speech-bubble per feedback in the current
 * scene, anchored to the pin's projected screen position. Positions
 * update every frame via requestAnimationFrame reading from the
 * shared `feedbackBubbles` projection map; we DON'T store positions
 * in React state because it would trigger a full re-render of every
 * bubble 60× per second.
 *
 * Render structure:
 *   <div.feedback-bubbles>
 *     <article.feedback-bubble ref={slot0}>…text…</article>
 *     <article.feedback-bubble ref={slot1}>…text…</article>
 *     …
 *   </div>
 *
 * Each bubble's `transform: translate(x, y)` is applied imperatively
 * on its ref so React only re-renders when the LIST OF IDS changes,
 * not when positions drift per frame. This mirrors the internal
 * fast-path drei's <Html> uses and keeps the overlay 60 fps cheap.
 *
 * Visibility:
 *   - The outer container mounts only while V is held
 *     (`isShowAllActive()`), so idle Play mode has zero overlay cost.
 *   - Per-bubble: if the projection says `visible=false` (behind the
 *     camera / past far plane), the DOM node gets `opacity: 0` via
 *     inline style. We don't remove it from the tree so the ref
 *     stays live and a fresh frame can un-hide it instantly when
 *     the player spins around.
 */
export function FeedbackBubblesOverlay({ scenePath }: { scenePath: string }) {
  const [showAll, setShowAll] = useState(() => isShowAllActive());
  const [feedbacks, setFeedbacks] = useState<Feedback[]>(() =>
    listFeedbacks(scenePath),
  );

  useEffect(() => {
    setShowAll(isShowAllActive());
    const unsub = subscribeShowAll(() => setShowAll(isShowAllActive()));
    return unsub;
  }, []);

  useEffect(() => {
    setFeedbacks(listFeedbacks(scenePath));
    const unsub = subscribeFeedbacks(() => {
      setFeedbacks(listFeedbacks(scenePath));
    });
    return unsub;
  }, [scenePath]);

  // Ref per feedback id. Rebuild only when the id set changes,
  // not on every render — the actual DOM transforms land via the
  // rAF loop below so React doesn't need to see positions.
  const refsById = useRef<Map<string, HTMLDivElement | null>>(new Map());
  useEffect(() => {
    // Prune refs for removed feedbacks.
    const live = new Set(feedbacks.map((fb) => fb.id));
    for (const id of refsById.current.keys()) {
      if (!live.has(id)) refsById.current.delete(id);
    }
  }, [feedbacks]);

  // rAF loop: read projections, apply to DOM transforms. Only runs
  // while the overlay is mounted (showAll && feedbacks.length > 0),
  // so there's no cost when V isn't held.
  useEffect(() => {
    if (!showAll) return;
    if (feedbacks.length === 0) return;
    let rafId = 0;
    const tick = () => {
      for (const fb of feedbacks) {
        const el = refsById.current.get(fb.id);
        if (!el) continue;
        const proj = getBubbleProjection(fb.id);
        if (!proj || !proj.visible) {
          // Leave the element in the tree but invisible. Setting
          // display:none instead would deallocate the refs we need
          // to keep warm for the next frame where it comes back
          // into view.
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
          continue;
        }
        // NDC → screen pixels. translate(-50%, -100%) on the inner
        // wrapper pins the pointer tip of the bubble to the pin,
        // with the bubble body growing upward.
        const xPct = (proj.x * 0.5 + 0.5) * 100;
        const yPct = (1 - (proj.y * 0.5 + 0.5)) * 100;
        el.style.left = `${xPct}%`;
        el.style.top = `${yPct}%`;
        el.style.opacity = '1';
        // Depth-based fade: bubbles on the far plane get slightly
        // transparent so foreground feedback reads as the "now"
        // layer. Eyeballed; 0.55 keeps distant bubbles readable.
        const depthAlpha = Math.max(0.55, 1 - proj.z);
        el.style.filter = `opacity(${depthAlpha})`;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [showAll, feedbacks]);

  if (!showAll) return null;
  if (feedbacks.length === 0) return null;

  return (
    <div className="feedback-bubbles" aria-hidden="true">
      {feedbacks.map((fb) => (
        <BubbleItem
          key={fb.id}
          feedback={fb}
          refCallback={(node) => {
            if (node) refsById.current.set(fb.id, node);
            else refsById.current.delete(fb.id);
          }}
        />
      ))}
    </div>
  );
}

function BubbleItem({
  feedback,
  refCallback,
}: {
  feedback: Feedback;
  refCallback: (node: HTMLDivElement | null) => void;
}) {
  // Start off-screen (opacity 0) so the first paint before the rAF
  // loop kicks in doesn't flash at (0, 0). The rAF handler will
  // immediately replace these styles on the next frame.
  const resolved = feedback.status === 'resolved';
  return (
    <div
      ref={refCallback}
      className={`feedback-bubble${resolved ? ' is-resolved' : ''}`}
      style={{ opacity: 0, left: '-9999px', top: '-9999px' }}
    >
      <div className="feedback-bubble-body">
        <div className="feedback-bubble-meta feedback-bubble-meta-top">
          {/*
            Status chip in the bubble header lets the V-overview
            double as a "what still needs attention" map — resolved
            bubbles drop back into the muted palette while open
            ones keep their warm colour, so the user can sweep the
            level and instantly see where the remaining work is.
          */}
          <span
            className={`feedback-status-badge${resolved ? ' is-resolved' : ' is-open'}`}
          >
            <span aria-hidden="true">{resolved ? '✓' : '●'}</span>
            {resolved ? '확인됨' : '확인중'}
          </span>
        </div>
        <div className="feedback-bubble-text">
          {feedback.text || <span className="muted">(내용 없음)</span>}
        </div>
        <div className="feedback-bubble-meta">
          <span className="feedback-bubble-reaction">
            <span aria-hidden="true">♥</span> {feedback.likes.length}
          </span>
          <span className="feedback-bubble-reaction">
            <span aria-hidden="true">💬</span> {feedback.comments.length}
          </span>
        </div>
      </div>
      <div className="feedback-bubble-tail" aria-hidden="true" />
    </div>
  );
}
