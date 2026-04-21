import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

import { publishPose } from './multiplayer';
import { playModeState } from './playModeState';
import type { PlayerControllerHandle } from './PlayerController';

/**
 * Throttled local-player pose broadcaster.
 *
 * Reads the PlayerController's current pose + animation state each
 * frame, but only actually transmits every `PUBLISH_PERIOD` seconds
 * to keep WebSocket traffic sane — 20 Hz is way more than enough for
 * remote-avatar smoothing (the receiver LERPs between samples anyway).
 *
 * The `visible` flag lets edit-mode lurkers stay "known to the room"
 * (they get chat + feedback events, and others can see them in the
 * player count) without showing their character running around at
 * the origin: RemotePlayers skips rendering when `visible` is false.
 */
export function LocalPoseBroadcaster({
  playerHandleRef,
  playMode,
}: {
  playerHandleRef: React.RefObject<PlayerControllerHandle>;
  playMode: boolean;
}) {
  const nextPublishRef = useRef(0);

  useFrame((_state, _dt) => {
    const now = performance.now();
    if (now < nextPublishRef.current) return;
    nextPublishRef.current = now + PUBLISH_PERIOD_MS;

    const h = playerHandleRef.current;
    if (!h) return;
    const pose = h.getPose();
    publishPose({
      position: pose.position,
      yaw: pose.yaw,
      anim: h.getAnimState(),
      crouching: playModeState.crouching,
      visible: playMode,
    });
  });

  return null;
}

const PUBLISH_PERIOD_MS = 50; // 20 Hz
