/**
 * Tiny pub/sub for "which feedback pin is currently under the
 * crosshair". Written from inside the R3F Canvas (a useFrame loop
 * that projects every pin into NDC and picks the one nearest the
 * screen centre), read from the DOM overlay that renders a
 * tooltip card above the reticle — both layers are too far apart
 * in the React tree to pass through props cheaply, and the value
 * changes every frame anyway so Zustand / Context would just add
 * overhead.
 *
 * Follows the same "module-level singleton + subscribe" shape as
 * `playModeState` / `feedbackStore`: one live value, synchronous
 * reads, listeners fire after every mutation.
 */

type Listener = () => void;

let currentId: string | null = null;
const listeners = new Set<Listener>();

/** Current hovered feedback id, or null when the crosshair isn't
 *  pointing at any pin. */
export function getHoveredFeedbackId(): string | null {
  return currentId;
}

/** Write a new hovered id (or null). No-op if unchanged — we check
 *  equality here so the frame-loop writer can call this every tick
 *  without forcing React renders when nothing has actually changed. */
export function setHoveredFeedbackId(id: string | null): void {
  if (currentId === id) return;
  currentId = id;
  for (const fn of listeners) fn();
}

/** React-friendly subscription. Returns the unsubscribe fn. */
export function subscribeHoveredFeedback(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
