/**
 * Shared state for the "show every feedback at once" overlay.
 *
 * Two things move through this module:
 *
 *   1. `showAll` — a boolean the user drives by holding V in Play
 *      mode. React components subscribe so the HTML overlay can
 *      mount / unmount and the Canvas-side probe can skip its
 *      per-frame projection work when the user isn't looking.
 *
 *   2. `projections` — a per-frame Map<feedbackId, BubbleProjection>
 *      written by a component inside the R3F Canvas (which has
 *      access to the live camera) and read by the DOM overlay. We
 *      use a module-level mutable map rather than React state
 *      because positions update at render cadence (60 Hz) and
 *      threading that through useState would trigger 60 re-renders
 *      per second across every bubble.
 *
 * The overlay uses its own requestAnimationFrame loop to read the
 * latest projections and apply them as CSS transforms directly on
 * refs — same "DOM fast-path, React only for structure" pattern
 * used by drei's <Html> internals.
 */

export interface BubbleProjection {
  /** NDC x in [-1, 1] (or outside when offscreen). */
  x: number;
  /** NDC y in [-1, 1]; Three's convention, positive = up. */
  y: number;
  /** Perspective depth in [0, 1] for in-frustum points. We keep
   *  this so the overlay can fade / scale bubbles by depth if we
   *  later decide far-away pins shouldn't dominate the screen. */
  z: number;
  /** False when the point is behind the camera or past the far
   *  plane — the overlay hides bubbles with `visible = false`
   *  rather than drawing a collapsed bubble at the frame edge. */
  visible: boolean;
}

const projections = new Map<string, BubbleProjection>();

export function setBubbleProjection(id: string, p: BubbleProjection): void {
  projections.set(id, p);
}

export function getBubbleProjection(id: string): BubbleProjection | undefined {
  return projections.get(id);
}

/** Drop projections for ids the caller no longer wants tracked (e.g.
 *  after a scene change). The probe calls this with the current scene
 *  feedback id set, so stale entries from other scenes vanish. */
export function pruneBubbleProjections(keepIds: Set<string>): void {
  for (const id of projections.keys()) {
    if (!keepIds.has(id)) projections.delete(id);
  }
}

export function clearBubbleProjections(): void {
  projections.clear();
}

// ------------------------------------------------------------------
// showAll toggle (driven by the V hotkey)
// ------------------------------------------------------------------

let showAll = false;
type Listener = () => void;
const listeners = new Set<Listener>();

export function isShowAllActive(): boolean {
  return showAll;
}

export function setShowAllActive(next: boolean): void {
  if (showAll === next) return;
  showAll = next;
  for (const fn of listeners) fn();
}

export function subscribeShowAll(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
