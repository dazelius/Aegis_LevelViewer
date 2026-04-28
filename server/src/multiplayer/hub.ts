import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

import type { Feedback } from '../feedback/feedbackStore.js';

/**
 * Lightweight presence / feedback-event hub.
 *
 * One WebSocket per tab. Each client "joins" a room keyed by the
 * Unity scene path it's currently viewing; the hub relays pose
 * updates and feedback mutation events to every other client in
 * the same room.
 *
 * The hub is *stateless about game logic*: it does not validate
 * positions, it does not run physics, it doesn't even guarantee
 * delivery. It just routes messages. Clients are trusted (the
 * server is intended for trusted internal use on a LAN) and
 * responsible for their own interpolation / anti-cheat / sanity
 * checking. A richer model can land later — the protocol version
 * field lets us evolve it without forcing a lockstep upgrade.
 *
 * Wire format: JSON strings. Small enough (poses are ~100 B each),
 * easy to debug, no schema compiler to drag around. Binary framing
 * is a pure optimization we'd reach for if someone actually hits a
 * 30-player room.
 *
 * Rate limiting: the natural rate limit for pose messages is the
 * client's render loop (60 Hz). We throttle re-broadcast to every
 * peer's connection but do NOT drop messages — at 60 Hz × 10 peers
 * × 100 B that's 60 KB/s outbound per client, well within even a
 * modest link. If we ever see backpressure we'll switch to
 * "latest-pose-wins" dropping on send buffer overflow.
 */

// ---------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------

export const HUB_PROTOCOL_VERSION = 1;

/** All client → server message shapes. `type` is the discriminator. */
type ClientMsg =
  | { type: 'hello'; nickname: string; scenePath: string }
  | { type: 'scene'; scenePath: string }
  | { type: 'pose'; pose: PeerPose }
  | { type: 'ping' };

/** Pose frame — what every viewer broadcasts each tick. `visible`
 *  distinguishes "I'm in Play mode → render my character" from
 *  "I'm just browsing in edit mode → show me as a lurker only". */
export interface PeerPose {
  position: [number, number, number];
  yaw: number;
  anim: string; // idle | runF | runB | runL | runR | jumpStart | jumpLoop | jumpEnd
  crouching: boolean;
  visible: boolean;
}

/** All server → client message shapes. */
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
  | { type: 'feedback_added'; feedback: Feedback }
  | { type: 'feedback_updated'; feedback: Feedback }
  | { type: 'feedback_removed'; scenePath: string; id: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

interface Client {
  id: string;
  nickname: string;
  scenePath: string;
  ws: WebSocket;
  lastPose: PeerPose | null;
}

/** Room = scenePath. Lookup is O(1) on each WS event. Empty rooms
 *  get removed on last-leave so the map doesn't grow forever. */
const rooms = new Map<string, Set<Client>>();
const clientById = new Map<string, Client>();

let hubWss: WebSocketServer | null = null;

// ---------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------

/**
 * Mount the WebSocket server on the existing HTTP listener. We share
 * the listener instead of opening a second port so the client can
 * reach the hub on the exact same origin it's already talking to
 * for HTTP — no extra CORS config, no extra port to remember.
 *
 * Path: `/ws/multiplayer`. Anything else WS-upgrade-requests gets a
 * 404 so we don't collide with whatever other ws usage might land
 * here later.
 */
export function attachMultiplayerHub(httpServer: Server): void {
  if (hubWss) return;
  const wss = new WebSocketServer({ noServer: true });
  hubWss = wss;

  httpServer.on('upgrade', (req, socket, head) => {
    // `req.url` can include query strings; strip them before
    // comparing against the path.
    const url = req.url ?? '';
    const pathname = url.split('?')[0];
    if (pathname !== '/ws/multiplayer') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => handleConnection(ws));

  console.log('[hub] multiplayer hub attached at ws://…/ws/multiplayer');
}

function handleConnection(ws: WebSocket): void {
  const id = makeId();
  const client: Client = {
    id,
    nickname: '',
    scenePath: '',
    ws,
    lastPose: null,
  };
  clientById.set(id, client);

  ws.on('message', (data) => {
    let msg: ClientMsg | null = null;
    try {
      msg = JSON.parse(data.toString()) as ClientMsg;
    } catch {
      sendTo(client, { type: 'error', message: 'bad json' });
      return;
    }
    if (!msg || typeof msg.type !== 'string') {
      sendTo(client, { type: 'error', message: 'missing type' });
      return;
    }
    try {
      dispatch(client, msg);
    } catch (err) {
      sendTo(client, { type: 'error', message: (err as Error).message });
    }
  });

  ws.on('close', () => {
    removeClientFromRoom(client);
    clientById.delete(client.id);
  });

  ws.on('error', (err) => {
    console.warn('[hub] ws error for', id, err);
  });
}

// ---------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------

function dispatch(client: Client, msg: ClientMsg): void {
  switch (msg.type) {
    case 'hello':
      onHello(client, msg.nickname, msg.scenePath);
      return;
    case 'scene':
      onSceneSwitch(client, msg.scenePath);
      return;
    case 'pose':
      onPose(client, msg.pose);
      return;
    case 'ping':
      sendTo(client, { type: 'pong' });
      return;
    default: {
      const exhaustive: never = msg;
      void exhaustive;
      sendTo(client, { type: 'error', message: 'unknown type' });
    }
  }
}

function onHello(client: Client, nicknameRaw: unknown, scenePathRaw: unknown): void {
  client.nickname = sanitizeNickname(nicknameRaw);
  const scenePath = sanitizeScenePath(scenePathRaw);
  joinRoom(client, scenePath);
}

function onSceneSwitch(client: Client, scenePathRaw: unknown): void {
  const scenePath = sanitizeScenePath(scenePathRaw);
  if (scenePath === client.scenePath) return;
  removeClientFromRoom(client);
  joinRoom(client, scenePath);
}

function onPose(client: Client, pose: PeerPose): void {
  if (!client.scenePath) return; // not joined a room yet
  const safe = sanitizePose(pose);
  if (!safe) return;
  client.lastPose = safe;
  broadcastToRoom(
    client.scenePath,
    { type: 'peer_pose', id: client.id, pose: safe },
    client.id,
  );
}

// ---------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------

function joinRoom(client: Client, scenePath: string): void {
  client.scenePath = scenePath;
  let room = rooms.get(scenePath);
  if (!room) {
    room = new Set();
    rooms.set(scenePath, room);
  }
  room.add(client);
  const peerSnapshot = Array.from(room)
    .filter((c) => c.id !== client.id)
    .map((c) => ({ id: c.id, nickname: c.nickname, pose: c.lastPose }));
  sendTo(client, {
    type: 'welcome',
    protocolVersion: HUB_PROTOCOL_VERSION,
    id: client.id,
    peers: peerSnapshot,
  });
  broadcastToRoom(
    scenePath,
    { type: 'peer_join', id: client.id, nickname: client.nickname },
    client.id,
  );
}

function removeClientFromRoom(client: Client): void {
  if (!client.scenePath) return;
  const room = rooms.get(client.scenePath);
  if (!room) {
    client.scenePath = '';
    return;
  }
  room.delete(client);
  broadcastToRoom(
    client.scenePath,
    { type: 'peer_leave', id: client.id },
    client.id,
  );
  if (room.size === 0) rooms.delete(client.scenePath);
  client.scenePath = '';
}

// ---------------------------------------------------------------------
// Feedback event bridge — called from the REST routes after a
// mutation lands, so every viewer sitting in the affected scene's
// room sees the new / deleted pin without waiting for the 15 s poll.
// ---------------------------------------------------------------------

export function broadcastFeedbackAdded(fb: Feedback): void {
  broadcastToRoom(fb.scenePath, { type: 'feedback_added', feedback: fb }, null);
}

/** Same room-scoped relay as `broadcastFeedbackAdded` but for in-place
 *  mutations (likes, comments) — the client treats it as "replace the
 *  record with this id" rather than "insert a new entry". */
export function broadcastFeedbackUpdated(fb: Feedback): void {
  broadcastToRoom(fb.scenePath, { type: 'feedback_updated', feedback: fb }, null);
}

export function broadcastFeedbackRemoved(scenePath: string, id: string): void {
  broadcastToRoom(scenePath, { type: 'feedback_removed', scenePath, id }, null);
}

// ---------------------------------------------------------------------
// Send / broadcast helpers
// ---------------------------------------------------------------------

function sendTo(client: Client, msg: ServerMsg): void {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  client.ws.send(JSON.stringify(msg));
}

/**
 * Broadcast `msg` to every client in `scenePath`'s room except
 * `excludeId` (pass `null` to include the sender). Serializes the
 * message once and reuses the string for every socket — important
 * when a room has several peers.
 */
function broadcastToRoom(scenePath: string, msg: ServerMsg, excludeId: string | null): void {
  const room = rooms.get(scenePath);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const c of room) {
    if (excludeId && c.id === excludeId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    c.ws.send(payload);
  }
}

// ---------------------------------------------------------------------
// Input sanitization
// ---------------------------------------------------------------------

function sanitizeNickname(x: unknown): string {
  if (typeof x !== 'string') return 'Guest';
  // Collapse whitespace, strip control chars, cap to 24 chars. Empty →
  // "Guest" so peer badges always have something to render.
  const trimmed = x.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return trimmed || 'Guest';
}

function sanitizeScenePath(x: unknown): string {
  if (typeof x !== 'string') return '';
  return x.slice(0, 512);
}

/**
 * Guard an incoming pose against the common garbage shapes
 * (missing fields, NaN, ±Infinity, bogus anim strings). We don't
 * validate ranges — it's easier to clip visibly-wrong avatars in
 * the client's renderer than to rely on the server to know what
 * "reasonable" means for each scene's playable volume.
 */
function sanitizePose(pose: unknown): PeerPose | null {
  if (!pose || typeof pose !== 'object') return null;
  const p = pose as Record<string, unknown>;
  const pos = p.position;
  if (!Array.isArray(pos) || pos.length !== 3) return null;
  const px = Number(pos[0]);
  const py = Number(pos[1]);
  const pz = Number(pos[2]);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
  const yaw = Number(p.yaw);
  if (!Number.isFinite(yaw)) return null;
  const anim = typeof p.anim === 'string' ? p.anim.slice(0, 32) : 'idle';
  const crouching = Boolean(p.crouching);
  const visible = Boolean(p.visible);
  return { position: [px, py, pz], yaw, anim, crouching, visible };
}

// ---------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------

function makeId(): string {
  // randomUUID available on Node 16+. We don't need cryptographic
  // strength — the id is just a label the clients use to key
  // incoming messages.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rand()}${rand()}`;
}
