import { wsUrl } from './api';
import { applyServerFeedbackEvent, type Feedback } from './feedbackStore';
import { getNickname, subscribeNickname } from './nickname';

/**
 * Client-side WebSocket manager for the Aegisgram multiplayer hub.
 *
 * One module-scope singleton owns the connection for the whole tab,
 * because (a) the browser caps concurrent WS connections per origin
 * and (b) we want `/level/...` → `/` → `/level/...` navigation to
 * keep the same id so other players don't see us "leave and
 * rejoin" every route change. The React components only talk to
 * the singleton through these exported hooks / functions.
 *
 * Lifecycle:
 *   - `ensureConnected()` opens the socket if it isn't already.
 *     Re-entrant; safe to call on every page mount.
 *   - `setCurrentScene(path)` announces the new room to the
 *     server. No-op if the path hasn't changed.
 *   - `publishPose(pose)` is called every render tick from Play
 *     mode (or edit mode with `visible:false`) to broadcast the
 *     local player's position.
 *   - `sendChat(text)` posts a chat message into the current room.
 *
 * The connection auto-reconnects with exponential backoff if the
 * server drops us — the hub is expected to be long-running but
 * might restart during development.
 */

// ---------------------------------------------------------------------
// Protocol mirror (keep in sync with server/src/multiplayer/hub.ts)
// ---------------------------------------------------------------------

export interface PeerPose {
  position: [number, number, number];
  yaw: number;
  anim: string;
  crouching: boolean;
  visible: boolean;
}

export interface Peer {
  id: string;
  nickname: string;
  pose: PeerPose | null;
  /** Local extrapolation helper: timestamp we received the last pose,
   *  used by RemotePlayers.tsx to lerp toward the latest target. */
  lastPoseAt: number;
}

type ServerMsg =
  | {
      type: 'welcome';
      protocolVersion: number;
      id: string;
      peers: Array<{ id: string; nickname: string; pose: PeerPose | null }>;
    }
  | { type: 'peer_join'; id: string; nickname: string }
  | { type: 'peer_leave'; id: string }
  | { type: 'peer_pose'; id: string; pose: PeerPose }
  | { type: 'peer_chat'; id: string; nickname: string; text: string; ts: number }
  | { type: 'feedback_added'; feedback: Feedback }
  | { type: 'feedback_updated'; feedback: Feedback }
  | { type: 'feedback_removed'; scenePath: string; id: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

// ---------------------------------------------------------------------
// Connection singleton
// ---------------------------------------------------------------------

let ws: WebSocket | null = null;
let selfId: string | null = null;
let currentScene = '';
let announcedScene = ''; // last scene we told the server about
let helloSent = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 500; // grows up to 10s

/** Last-seen state of every peer in the current room (excluding self). */
const peers = new Map<string, Peer>();

// --- Chat log (bounded ring of recent messages for the HUD) ---
export interface ChatLine {
  id: string; // sender id (empty for system lines)
  nickname: string;
  text: string;
  ts: number;
  self: boolean;
}
const CHAT_MAX = 50;
const chatLog: ChatLine[] = [];

// --- Feedback realtime bridge (notifies the feedbackStore) ---
type FeedbackEventListener =
  | { type: 'added'; feedback: Feedback }
  | { type: 'updated'; feedback: Feedback }
  | { type: 'removed'; scenePath: string; id: string };
const feedbackListeners = new Set<(ev: FeedbackEventListener) => void>();

export function subscribeFeedbackEvents(
  fn: (ev: FeedbackEventListener) => void,
): () => void {
  feedbackListeners.add(fn);
  return () => {
    feedbackListeners.delete(fn);
  };
}

// ---------------------------------------------------------------------
// Pub-sub for React components
// ---------------------------------------------------------------------

type VoidSub = () => void;
const peerSubs = new Set<VoidSub>();
const chatSubs = new Set<VoidSub>();

function notifyPeers(): void {
  for (const fn of peerSubs) fn();
}

function notifyChat(): void {
  for (const fn of chatSubs) fn();
}

export function subscribePeers(fn: VoidSub): () => void {
  peerSubs.add(fn);
  return () => {
    peerSubs.delete(fn);
  };
}

export function subscribeChat(fn: VoidSub): () => void {
  chatSubs.add(fn);
  return () => {
    chatSubs.delete(fn);
  };
}

/** Snapshot of all peers currently in the room. Fresh array each call
 *  so React's shallow-compare picks up changes. Excludes self. */
export function listPeers(): Peer[] {
  return Array.from(peers.values());
}

/** Snapshot of the recent chat log (oldest first). */
export function listChat(): ChatLine[] {
  return chatLog.slice();
}

export function getSelfId(): string | null {
  return selfId;
}

// ---------------------------------------------------------------------
// Socket open / reconnect
// ---------------------------------------------------------------------

function buildUrl(): string {
  // `wsUrl()` honours the Vite `base` so the URL survives reverse-proxy
  // deploys (e.g. platform mount at `/api/v1/ai-tools/21/proxy/`). The
  // Vite dev server still proxies `/ws/...` through to the backend via
  // `server.proxy` (configured in vite.config.ts) when BASE_URL is '/'.
  return wsUrl('/ws/multiplayer');
}

/** Ensure the WebSocket is open (or connecting). Safe to call many
 *  times. Idempotent. */
export function ensureConnected(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(buildUrl());
  } catch (err) {
    console.warn('[multiplayer] failed to construct WS:', err);
    scheduleReconnect();
    return;
  }
  helloSent = false;
  announcedScene = '';
  ws.addEventListener('open', onOpen);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', (e) => {
    console.warn('[multiplayer] ws error:', e);
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    ensureConnected();
  }, reconnectDelay);
}

function onOpen(): void {
  reconnectDelay = 500;
  sendHello();
}

function onClose(): void {
  // Treat all peers as gone — the server has no idea who we were.
  selfId = null;
  helloSent = false;
  announcedScene = '';
  if (peers.size > 0) {
    peers.clear();
    notifyPeers();
  }
  ws = null;
  scheduleReconnect();
}

function onMessage(ev: MessageEvent<string>): void {
  let msg: ServerMsg | null = null;
  try {
    msg = JSON.parse(ev.data) as ServerMsg;
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'welcome': {
      selfId = msg.id;
      peers.clear();
      for (const p of msg.peers) {
        peers.set(p.id, {
          id: p.id,
          nickname: p.nickname,
          pose: p.pose,
          lastPoseAt: p.pose ? performance.now() : 0,
        });
      }
      notifyPeers();
      return;
    }
    case 'peer_join': {
      peers.set(msg.id, { id: msg.id, nickname: msg.nickname, pose: null, lastPoseAt: 0 });
      notifyPeers();
      pushSystemChat(`${msg.nickname || 'Guest'} 님이 입장했어요.`);
      return;
    }
    case 'peer_leave': {
      const p = peers.get(msg.id);
      peers.delete(msg.id);
      if (p) pushSystemChat(`${p.nickname || 'Guest'} 님이 나갔어요.`);
      notifyPeers();
      return;
    }
    case 'peer_pose': {
      const existing = peers.get(msg.id);
      if (!existing) {
        // Pose before join — create a placeholder entry so we don't
        // drop the data. The join event (or a fresh welcome after
        // reconnect) fills in the nickname.
        peers.set(msg.id, {
          id: msg.id,
          nickname: '',
          pose: msg.pose,
          lastPoseAt: performance.now(),
        });
      } else {
        existing.pose = msg.pose;
        existing.lastPoseAt = performance.now();
      }
      // Pose updates fire at render cadence — don't re-render React
      // components for every one of them. Consumers read live pose
      // inside useFrame instead (see RemotePlayers.tsx).
      return;
    }
    case 'peer_chat': {
      pushChat({
        id: msg.id,
        nickname: msg.nickname,
        text: msg.text,
        ts: msg.ts,
        self: selfId !== null && msg.id === selfId,
      });
      return;
    }
    case 'feedback_added': {
      // Apply to the local cache so pins / panel / feed re-render
      // immediately, THEN notify any extra listeners (the feed page
      // watches this to reorder its timeline without a full refetch).
      applyServerFeedbackEvent({ type: 'added', feedback: msg.feedback });
      for (const fn of feedbackListeners) fn({ type: 'added', feedback: msg.feedback });
      return;
    }
    case 'feedback_updated': {
      // Likes / comments mutation. Same fan-out pattern as add —
      // local cache first so the pin tooltip and panel card flip
      // their state instantly, then the listener set so the global
      // feed page can do a minimal in-place update instead of a
      // full refetch.
      applyServerFeedbackEvent({ type: 'updated', feedback: msg.feedback });
      for (const fn of feedbackListeners) fn({ type: 'updated', feedback: msg.feedback });
      return;
    }
    case 'feedback_removed': {
      applyServerFeedbackEvent({
        type: 'removed',
        scenePath: msg.scenePath,
        id: msg.id,
      });
      for (const fn of feedbackListeners) {
        fn({ type: 'removed', scenePath: msg.scenePath, id: msg.id });
      }
      return;
    }
    case 'error': {
      console.warn('[multiplayer] server error:', msg.message);
      return;
    }
    case 'pong':
      return;
    default:
      return;
  }
}

function pushChat(line: ChatLine): void {
  chatLog.push(line);
  while (chatLog.length > CHAT_MAX) chatLog.shift();
  notifyChat();
}

function pushSystemChat(text: string): void {
  pushChat({ id: '', nickname: '시스템', text, ts: Date.now(), self: false });
}

// ---------------------------------------------------------------------
// Outbound helpers
// ---------------------------------------------------------------------

function sendHello(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'hello',
      nickname: getNickname(),
      scenePath: currentScene,
    }),
  );
  helloSent = true;
  announcedScene = currentScene;
}

function sendSceneSwitch(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'scene', scenePath: currentScene }));
  announcedScene = currentScene;
  // Moving rooms: drop the peer list we had for the old scene.
  if (peers.size > 0) {
    peers.clear();
    notifyPeers();
  }
}

/** Change the scene this client is "in". Pass `''` to leave the
 *  current room without joining a new one (e.g. user navigated to
 *  the global feed page). */
export function setCurrentScene(scenePath: string): void {
  const next = scenePath ?? '';
  if (next === currentScene) return;
  currentScene = next;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Connection isn't open yet — `sendHello` will pick up
    // `currentScene` on open.
    return;
  }
  if (!helloSent) {
    sendHello();
  } else if (currentScene !== announcedScene) {
    sendSceneSwitch();
  }
}

/** Broadcast the local player's pose. Low-overhead: one JSON.stringify
 *  per call, expected to be invoked from useFrame at 30–60 Hz.
 *  No-ops when the socket isn't open or we haven't joined a scene. */
export function publishPose(pose: PeerPose): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!currentScene) return;
  if (!helloSent) return;
  ws.send(JSON.stringify({ type: 'pose', pose }));
}

/** Post a chat message into the current room. */
export function sendChat(text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const trimmed = text.trim().slice(0, 500);
  if (!trimmed) return;
  ws.send(JSON.stringify({ type: 'chat', text: trimmed }));
}

// Nickname changes mid-session: re-send `hello` so the server (and
// everyone else in the room) learns the new name. We piggy-back on
// the hello handler rather than introducing a fourth message type
// for a rarely-fired event.
subscribeNickname(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendHello();
});
