import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

// drei's OrbitControls re-exports the three-stdlib class as its ref
// shape. Rather than adding three-stdlib as an explicit dep just to
// name the type, resolve it through React so the compiler uses
// whatever drei is already vendoring.
type OrbitControlsRef = React.ComponentRef<typeof OrbitControls>;
import {
  fetchScene,
  fetchRebakeStatus,
  isUnityExport,
  triggerRebake,
  type BatchStatus,
  type GameObjectNode,
  type SceneJson,
  type SceneLoadProgress,
  type UnityExport,
} from '../lib/api';
import {
  DEBUG_SLOT_PALETTE,
  SceneRoots,
  SelectionProvider,
  type SceneSelection,
} from '../lib/sceneToR3F';
import {
  subscribeFbxCacheStats,
  getFbxFailures,
  type FbxCacheStats,
  type FbxFailure,
} from '../lib/fbxCache';
import {
  UnityExportRoots,
  UnityRenderSettingsApply,
  computeUnityExportFraming,
  getUnityExportStats,
} from '../lib/unityExportToR3F';
import {
  PlayerController,
  type PlayerControllerHandle,
} from '../lib/PlayerController';
import { ShoulderCamera } from '../lib/ShoulderCamera';
import { Shooter, type CameraRecoilAPI } from '../lib/Shooter';
import { defaultPose, findNodeWorldPosition, type PlayerPose } from '../lib/playerPose';
import { playModeState, resetPlayModeState } from '../lib/playModeState';
import { FeedbackComposer, type FeedbackCaptureContext } from '../lib/FeedbackComposer';
import { FeedbackBubblesOverlay } from '../lib/FeedbackBubblesOverlay';
import {
  isShowAllActive as isBubblesShowAllActive,
  setShowAllActive as setBubblesShowAllActive,
} from '../lib/feedbackBubbles';
import { FeedbackPins } from '../lib/FeedbackPins';
import { FeedbackPanel } from '../lib/FeedbackPanel';
import { FeedbackTooltip } from '../lib/FeedbackTooltip';
import { RemotePlayers } from '../lib/RemotePlayers';
import { LocalPoseBroadcaster } from '../lib/LocalPoseBroadcaster';
import { ChatHUD } from '../lib/ChatHUD';
import { ensureConnected, setCurrentScene } from '../lib/multiplayer';

export default function LevelViewer() {
  const params = useParams();
  const relPath = decodeSplat(params['*'] ?? '');
  const [scene, setScene] = useState<SceneJson | UnityExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SceneLoadProgress | null>(null);
  const [loadStartedAt, setLoadStartedAt] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!relPath) return;
    let cancelled = false;
    setScene(null);
    setError(null);
    setProgress(null);
    setLoadStartedAt(Date.now());
    (async () => {
      try {
        const data = await fetchScene(relPath, (p) => {
          if (!cancelled) setProgress(p);
        });
        if (!cancelled) setScene(data);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  if (error) {
    return <SceneLoadOverlay relPath={relPath} error={error} />;
  }
  if (!scene) {
    return (
      <SceneLoadOverlay
        relPath={relPath}
        progress={progress}
        loadStartedAt={loadStartedAt}
      />
    );
  }

  if (isUnityExport(scene)) {
    return <UnityExportCanvas scene={scene} relPath={relPath} />;
  }
  return <ViewerCanvas scene={scene} relPath={relPath} />;
}

/**
 * Full-viewport overlay shown while the scene is loading or after a
 * fatal load error. Gives the user real feedback on the (often slow)
 * Git LFS fetch that backs a cold scene load — elapsed wall-clock,
 * attempt counter, server-supplied hint, and a progress bar scaled
 * against the client's retry budget so the bar reaches ~100% right
 * around the point where the client would give up.
 */
function SceneLoadOverlay({
  relPath,
  progress,
  loadStartedAt,
  error,
}: {
  relPath: string;
  progress?: SceneLoadProgress | null;
  loadStartedAt?: number;
  error?: string;
}): JSX.Element {
  // We tick a local clock so "elapsed" keeps updating even during the
  // 2.5s sleep between server polls (progress updates only fire at
  // phase boundaries, which would otherwise make the number look
  // frozen to the user).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (error) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [error]);

  const sceneName = relPath ? relPath.split('/').pop() || relPath : '';
  const elapsedMs = loadStartedAt ? Math.max(0, now - loadStartedAt) : 0;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  const budgetMs = progress?.totalBudgetMs ?? 75_000;
  const pct = Math.min(100, Math.round((elapsedMs / budgetMs) * 100));

  // Hint copy depends on how long we've been waiting. Server-provided
  // hints (from 409 responses) always win once we see one — they
  // reflect the actual in-flight state. Before the first 409 we pick
  // an increasingly descriptive message as elapsed grows, because
  // "Connecting" at 2 minutes reads as broken.
  const headline = error ? 'Failed to load scene' : 'Loading scene…';
  let hint: string;
  if (error) {
    hint = error;
  } else if (progress?.hint) {
    hint = progress.hint;
  } else if (elapsedMs < 1500) {
    hint = '서버와 연결 중…';
  } else if (elapsedMs < 20_000) {
    hint = 'Git LFS에서 씬 파일을 받는 중입니다';
  } else if (elapsedMs < 60_000) {
    hint = '대용량 에셋을 받고 있습니다 — 잠시만요';
  } else {
    hint = '처음 여는 씬은 수 분 걸릴 수 있습니다. 다음엔 즉시 열립니다.';
  }

  // Only surface the retry count once we've been retrying enough that
  // it matters for diagnosing hung loads (> ~1 min). Showing it
  // earlier misleads users into thinking it's a download progress
  // fraction ("7/30 files"), which it is not.
  const showRetryBadge = Boolean(progress) && elapsedMs > 60_000;

  return (
    <div className={`scene-load-overlay${error ? ' is-error' : ''}`}>
      <div className="scene-load-card" role="status" aria-live="polite">
        {!error && (
          <div className="scene-load-spinner" aria-hidden="true">
            <div className="scene-load-spinner-ring" />
          </div>
        )}
        {error && (
          <div className="scene-load-error-icon" aria-hidden="true">!</div>
        )}
        <div className="scene-load-headline">{headline}</div>
        {sceneName && <div className="scene-load-scene">{sceneName}</div>}
        {relPath && <div className="scene-load-path">{relPath}</div>}

        {!error && (
          <>
            <div className="scene-load-progress">
              <div
                className="scene-load-progress-bar"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="scene-load-meta">
              <span>{elapsedSec}s 경과</span>
              {showRetryBadge && progress && (
                <span className="scene-load-retry">
                  서버 확인 {progress.attempt}회
                </span>
              )}
            </div>
          </>
        )}

        <div className="scene-load-hint">{hint}</div>

        {!error && elapsedMs > 20_000 && (
          <div className="scene-load-detail">
            이 씬의 .unity / 종속 에셋이 아직 로컬에 없어 Git LFS에서
            받는 중입니다. 같은 씬을 다시 열면 거의 즉시 로드됩니다.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Dev-only hook: exposes the live R3F `scene` (and `THREE`) on `window` so
 * we can inspect transforms / bounds / meshes from the browser console when
 * diagnosing why a level looks wrong. Ship as-is — it costs one effect per
 * mount and nothing at all if the console hook is never read.
 */
function DebugSceneHook() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    (window as unknown as { __r3fScene?: unknown; __THREE?: unknown }).__r3fScene = scene;
    (window as unknown as { __r3fScene?: unknown; __THREE?: unknown }).__THREE = THREE;
    return () => {
      const w = window as unknown as { __r3fScene?: unknown };
      if (w.__r3fScene === scene) delete w.__r3fScene;
    };
  }, [scene]);
  return null;
}

/**
 * Publishes the live R3F camera on the provided ref so callers
 * outside the Canvas tree (the Enter-key feedback capture in
 * LevelViewer) can read pose without threading context.
 */
function CameraRefBridge({
  cameraRef,
}: {
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
}) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    cameraRef.current = camera;
    return () => {
      if (cameraRef.current === camera) cameraRef.current = null;
    };
  }, [camera, cameraRef]);
  return null;
}

/**
 * Bridges editor-mode (OrbitControls) and Play-mode (QuarterviewCamera)
 * camera state across toggles so the user doesn't lose their place.
 *
 * When Play mode turns ON:
 *  - snapshot the current camera position + orbit target,
 *  - from the next frame on, QuarterviewCamera owns camera.position.
 *
 * When Play mode turns OFF:
 *  - restore camera.position to the snapshot,
 *  - restore orbit.target to the snapshot and call `.update()` so the
 *    controls resume orbiting around the remembered focus instead of
 *    snapping to scene center.
 *
 * Why not unmount OrbitControls during Play: drei's OrbitControls
 * re-reads its `target` prop only on mount, so remounting it would
 * reset the saved target anyway. Keeping it mounted-but-disabled is
 * cheaper and preserves damping velocity across the toggle.
 */
function OrbitStateKeeper({
  playMode,
  orbitRef,
}: {
  playMode: boolean;
  orbitRef: React.MutableRefObject<OrbitControlsRef | null>;
}) {
  const camera = useThree((s) => s.camera);
  const saved = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const prev = useRef(playMode);
  useEffect(() => {
    if (prev.current === playMode) return;
    if (playMode) {
      saved.current = {
        pos: camera.position.clone(),
        target: orbitRef.current?.target?.clone() ?? new THREE.Vector3(),
      };
    } else if (saved.current) {
      camera.position.copy(saved.current.pos);
      const ctrl = orbitRef.current;
      if (ctrl) {
        ctrl.target.copy(saved.current.target);
        ctrl.update();
      }
    }
    prev.current = playMode;
  }, [playMode, camera, orbitRef]);
  return null;
}

function ViewerCanvas({ scene, relPath }: { scene: SceneJson; relPath: string }) {
  const framing = useMemo(() => computeFraming(scene.roots), [scene]);
  const fbx = useFbxCacheStats();
  const [selection, setSelection] = useState<SceneSelection | null>(null);
  // Colliders (and disabled renderers) are hidden by default so the viewer
  // matches Unity's Game view. Flipping the HUD toggle shows them for
  // physics-hull debugging — useful when a prop clearly has the wrong
  // collision shape relative to its visual mesh.
  const [showColliders, setShowColliders] = useState(false);

  // HUD panel that lists the specific FBX GUIDs currently in a terminal
  // failure state. Gated behind a click on the "N failed" badge because
  // 99% of sessions have failed=0 — no reason to always render a panel.
  // When shown we also refresh the snapshot on each stats publish so the
  // list doesn't go stale as more retries settle.
  const [showFbxFailures, setShowFbxFailures] = useState(false);

  // Diagnostic: swap every mesh's textured material for a flat per-slot
  // color so the user can see at a glance which geometry references which
  // submesh slot, unmediated by UV or texture binding.
  const [debugSubmeshColors, setDebugSubmeshColors] = useState(false);

  // Diagnostic: swap every mesh's textured material for a checkerboard
  // UV texture with axis markers. Isolates UV-layout problems (mirror /
  // rotation / squash / wrong channel) from slot-binding problems.
  const [debugUvCheckerboard, setDebugUvCheckerboard] = useState(false);

  // Diagnostic: rebuild every lit material as MeshBasicMaterial with only
  // the base map — no PBR shading, no emission, no tone mapping. Isolates
  // "does the atlas texture paint the expected pixels" from every
  // lighting / shading variable.
  const [debugUnlitPreview, setDebugUnlitPreview] = useState(false);

  // Diagnostic: force `flipY = false` on every texture. Detects double-flip
  // bugs where the server-side decoder already emits GL-oriented image data
  // and three.js's default `flipY = true` inverts it a second time.
  const [debugFlipYOff, setDebugFlipYOff] = useState(false);

  // Per-FBX slot-permutation overrides, keyed by lowercased mesh GUID.
  // Edited from the Inspector when the selected object's FBX exhibits
  // slot-ordering mismatch between Unity and FBXLoader. A value of
  // `[2,1,0,3]` means "slot 0 should pull from m_Materials[2], slot 1
  // from [1], slot 2 from [0], slot 3 from [3]". Stored at the Canvas
  // level so all instances of the same FBX update together (matches
  // Unity's own binding granularity — edits to the imported FBX's
  // material remap affect every placement in the scene).
  const [slotPermutations, setSlotPermutations] = useState<Record<string, number[]>>({});
  const setSlotPermutation = (meshGuid: string, perm: number[] | null) => {
    setSlotPermutations((prev) => {
      const next = { ...prev };
      const key = meshGuid.toLowerCase();
      if (perm === null) delete next[key];
      else next[key] = perm;
      return next;
    });
  };

  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  // --- Play mode (shoulder-view shooter camera + WASD + mouse-look) ---
  //
  // Play mode and the editor's OrbitControls are mutually exclusive:
  // while Play is ON, ShoulderCamera mutates the camera every frame
  // and OrbitControls is disabled via `enabled={!playMode}`. We keep
  // OrbitControls *mounted* either way so its internal target/damping
  // state survives a Play session — when the user exits we restore
  // the saved camera transform and `.update()` the controls.
  //
  // The user-facing gesture is NOT a HUD toggle — a dedicated
  // service-style "Play" button at the bottom-right of the viewer
  // enters Play mode AND requests pointer lock on the canvas in the
  // same click (browsers require the lock request to be inside a user
  // gesture). Exiting is driven by pointer lock release (ESC, focus
  // loss, tab-out): whenever the lock is dropped we fall back to the
  // editor. That keeps Play mode's "there's a cursor captured" state
  // truly 1:1 with the React `playMode` flag — no "stuck in Play but
  // the mouse is free" failure mode.
  const [playMode, setPlayMode] = useState(false);
  // Crouch toggle — lives in LevelViewer (same layer as pointer lock
  // / playMode) so ShoulderCamera can receive it as a prop (preset
  // swap) and `playModeState.crouching` stays in sync for the non-
  // React-rendering consumers (PlayerController, CharacterAvatar).
  const [crouching, setCrouching] = useState(false);
  // ADS (aim down sights) toggle — held while the right mouse button
  // is down. Drives the ShoulderCamera preset swap (Stand_Default →
  // Stand_Aim: narrower FOV, shoulder pulled in, tighter look
  // sensitivity) and propagates into `playModeState.aiming` so
  // CharacterAvatar can play the shouldered aim clip even when the
  // trigger isn't held. Distinct React state (not just a ref) because
  // the preset prop on ShoulderCamera needs to re-render on change —
  // the per-frame easing inside ShoulderCamera handles the smooth
  // transition from there.
  const [aiming, setAiming] = useState(false);
  // Feedback composer state. When non-null, the modal is open with
  // the frozen capture context (thumbnail / aim / camera pose).
  // While the composer is up we intentionally release pointer lock
  // (so the user can click "등록" / "취소" and type a paragraph)
  // but keep `playMode` true so the Canvas subtree — player, camera,
  // shooter — stays mounted. That's the whole reason we gate the
  // pointer-lock-release → exit-play bridge on `!composerOpenRef`:
  // the composer legitimately needs to release the lock without
  // tearing down Play mode.
  const [composer, setComposer] = useState<FeedbackCaptureContext | null>(null);
  const composerOpenRef = useRef(false);
  useEffect(() => {
    composerOpenRef.current = composer !== null;
  }, [composer]);

  // Multiplayer room membership. Joining the room (keyed by scene
  // path) lets remote players see our avatar, and subscribes us to
  // chat + feedback realtime events. Leave on unmount so navigating
  // away cleans up presence for everyone else.
  useEffect(() => {
    ensureConnected();
    setCurrentScene(relPath);
    return () => {
      setCurrentScene('');
    };
  }, [relPath]);
  const playerHandleRef = useRef<PlayerControllerHandle>(null);
  const orbitRef = useRef<OrbitControlsRef | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // THREE.Camera captured from the R3F Canvas via an effect-child
  // hook, so the Enter-key handler (which lives outside the Canvas
  // tree) can read the live camera pose at capture time without
  // routing through a Zustand / context jungle.
  const cameraRef = useRef<THREE.Camera | null>(null);
  // ShoulderCamera publishes a recoil API here so the Shooter can
  // inject camera kick without a direct ref back to the camera.
  const cameraRecoilRef = useRef<CameraRecoilAPI | null>(null);

  // Seeded once per scene. Stable identity is important — PlayerController
  // treats `initialPose` as "snap to this" so we don't want to teleport
  // the player every frame.
  //
  // Spawn rule: if a `SafetyZone_SM` object exists anywhere in the scene
  // hierarchy, drop the player 5 m above it and let gravity + the per-frame
  // ground raycast settle them onto the zone's top face. Fallback to the
  // scene-framing center when no such anchor is present (dev scenes, legacy
  // levels). The +5 m offset is a "close enough" fudge — big enough that
  // we land on the object's actual top surface rather than on whatever
  // floor is underneath it, small enough that the fall-in feels instant.
  const initialPose: PlayerPose = useMemo(
    () => {
      const anchor = findNodeWorldPosition(scene.roots, 'SafetyZone_SM');
      const spawnLiftAboveAnchor = 5;
      const spawn: [number, number, number] = anchor
        ? [anchor[0], anchor[1] + spawnLiftAboveAnchor, anchor[2]]
        : [framing.center[0], framing.floorY + spawnLiftAboveAnchor, framing.center[2]];
      if (anchor) {
        // eslint-disable-next-line no-console
        console.info(
          `[play] spawn anchored on SafetyZone_SM @ (${anchor[0].toFixed(2)}, ${anchor[1].toFixed(2)}, ${anchor[2].toFixed(2)})`,
        );
      }
      return defaultPose(
        spawn,
        // Clamp chase distance so it reads from a 20 m room up to a
        // 400 m outdoor map. 6 % of the scene radius is roughly
        // shoulder-distance for a human, floored at 4 m so a small
        // prop scene still frames the avatar.
        Math.max(4, Math.min(20, framing.radius * 0.06)),
      );
    },
    [framing, scene.roots],
  );

  const enterPlay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      // Canvas still mounting; flip the state flag anyway and let the
      // user click the canvas to acquire pointer lock manually.
      resetPlayModeState();
      setPlayMode(true);
      return;
    }
    // Wipe any residual firing / fireTick / muzzle state from a
    // prior Play session so the first shot of a new session isn't
    // treated as "already firing".
    resetPlayModeState();
    setPlayMode(true);
    // Must be called synchronously inside the click handler so the
    // user gesture is honoured. `requestPointerLock` returns a Promise
    // on modern Chrome; swallow rejection (e.g. insecure context)
    // without reverting the flag — user can re-click the canvas.
    const result = canvas.requestPointerLock?.();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        /* pointer-lock refused; stay in play mode, they can click the
           canvas to retry */
      });
    }
  }, []);

  const exitPlay = useCallback(() => {
    setPlayMode(false);
    // Uncrouch on exit so re-entering Play starts in the default
    // standing stance. Otherwise a user who crouches, exits, and
    // re-enters would find themselves already crouched, with no
    // visible UI affordance to undo it.
    setCrouching(false);
    // Drop ADS too — RMB state is transient; re-entering Play
    // should open in the neutral non-aiming pose.
    setAiming(false);
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }, []);

  // Mirror the React `crouching` state into the mutable shared
  // playModeState ref so non-React consumers (PlayerController,
  // CharacterAvatar) see the same value each frame without having
  // to accept it as a prop.
  useEffect(() => {
    playModeState.crouching = crouching;
  }, [crouching]);

  // Same bridge for the `aiming` flag — CharacterAvatar reads it
  // every frame to pick the shouldered aim clip instead of the
  // relaxed idle / sprint, and PlayerController reads it to slow
  // movement slightly while the scope is up.
  useEffect(() => {
    playModeState.aiming = aiming;
  }, [aiming]);

  // Drive a top-level body class while in Play mode so the global
  // app chrome (header with Aegisgram brand, Back/Scenes
  // buttons, Git Sync) can hide itself via CSS. The header is rendered
  // by `App.tsx` — a parent of this route — so we can't conditionally
  // unmount it from here without threading state up. Toggling a body
  // class is a small, self-contained side-effect that cleans itself up
  // on unmount (e.g. navigating away mid-play).
  useEffect(() => {
    if (!playMode) return;
    document.body.classList.add('play-mode');
    return () => {
      document.body.classList.remove('play-mode');
    };
  }, [playMode]);

  // C key → toggle crouch. Only active while Play is on (we scope
  // the listener on `playMode` dep). Repeat events from a held key
  // are ignored so holding C doesn't thrash the stance.
  useEffect(() => {
    if (!playMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyC') return;
      if (e.repeat) return;
      setCrouching((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playMode]);

  // Right mouse button → aim down sights (hold). The gesture is
  // deliberately HOLD-to-aim rather than toggle because that matches
  // the muscle memory of every shooter users are likely to know;
  // toggling would also desync badly with the trigger (LMB) when the
  // user pulls both at once.
  //
  // Listens on the window rather than the canvas so a button release
  // outside the canvas area (dragging the mouse off screen, alt-
  // tabbing) still clears the aiming flag — we never want to strand
  // the player in permanent ADS because the mouseup event was
  // captured by some other element. `contextmenu` is swallowed on
  // the canvas so the native right-click menu doesn't pop while the
  // user is just aiming; it stays functional on the surrounding
  // editor UI.
  useEffect(() => {
    if (!playMode) return;
    const canvas = canvasRef.current;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      // Block ADS while a modal (feedback composer, chat input) has
      // suppressed player input — otherwise right-clicking through
      // the composer to clear Chrome's gesture would silently zoom
      // the camera under the modal.
      if (playModeState.inputSuppressed) return;
      setAiming(true);
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 2) return;
      setAiming(false);
    };
    const onBlur = () => setAiming(false);
    const onCtx = (e: Event) => {
      e.preventDefault();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    canvas?.addEventListener('contextmenu', onCtx);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
      canvas?.removeEventListener('contextmenu', onCtx);
    };
  }, [playMode]);

  // Bind Play mode to pointer-lock ownership. When the browser
  // releases the lock (user hit ESC, tabbed out, canvas lost focus),
  // fall back to editor mode. `wasLocked` guards against the first
  // `pointerlockchange` that fires BEFORE we've locked from exiting
  // us prematurely. The composer exception: when the lock is
  // released specifically because we opened the feedback composer,
  // don't collapse play mode — the composer itself will re-acquire
  // the lock (or exit) on close.
  useEffect(() => {
    const wasLocked = { current: false };
    const onChange = () => {
      const isLocked = document.pointerLockElement === canvasRef.current;
      if (wasLocked.current && !isLocked && !composerOpenRef.current) {
        setPlayMode(false);
      }
      wasLocked.current = isLocked;
    };
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);

  // Enter → capture current frame + aim + camera pose into a
  // FeedbackCaptureContext and open the composer. Gated on:
  //   - Play mode ON (Enter is harmless in the editor)
  //   - pointer lock active (so we know the user was actually aiming
  //     at something via the centred reticle, not typing into some
  //     stray input field)
  //   - `aimValid` — refuse to anchor a feedback on the sky-fallback
  //     far point. User-visible toast would be nicer but the usual
  //     cause (crosshair pointed into skybox) self-corrects as soon
  //     as they aim at real geometry, so a silent no-op is fine.
  //   - composer not already open
  //
  // Capture happens synchronously inside the key handler so the
  // canvas buffer we toDataURL belongs to the same frame the user
  // saw. We enable `gl.preserveDrawingBuffer` below — without it,
  // toDataURL returns a blank image because three.js clears the
  // back buffer immediately after present. Note the per-frame cost
  // of preserveDrawingBuffer is negligible for our scene sizes.
  useEffect(() => {
    if (!playMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (composerOpenRef.current) return;
      if (document.pointerLockElement !== canvasRef.current) return;
      if (!playModeState.aimValid) return;
      const canvas = canvasRef.current;
      const cam = cameraRef.current;
      const handle = playerHandleRef.current;
      if (!canvas || !cam || !handle) return;
      e.preventDefault();
      e.stopPropagation();

      let thumbnail = '';
      try {
        thumbnail = canvas.toDataURL('image/png');
      } catch (err) {
        // preserveDrawingBuffer should make this always succeed, but
        // CORS-tainted scenes (e.g. remote textures without CORS
        // headers) can still throw on read-back. Surface and bail.
        // eslint-disable-next-line no-console
        console.warn('[feedback] canvas.toDataURL failed:', err);
        return;
      }
      const aim = playModeState.aimPoint;
      const pose = handle.getPose();
      const persp = cam as THREE.PerspectiveCamera;
      const capture: FeedbackCaptureContext = {
        scenePath: relPath,
        anchor: [aim.x, aim.y, aim.z],
        thumbnail,
        cameraPose: {
          position: [cam.position.x, cam.position.y, cam.position.z],
          quaternion: [
            cam.quaternion.x,
            cam.quaternion.y,
            cam.quaternion.z,
            cam.quaternion.w,
          ],
          fov: typeof persp.fov === 'number' ? persp.fov : 50,
        },
        playerPose: {
          position: pose.position,
          yaw: pose.yaw,
        },
      };
      setComposer(capture);
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playMode, relPath]);

  // Re-acquire pointer lock after the composer closes — matches the
  // user's expectation "I pressed Enter to leave a note, now I'm
  // back in the game". On rare occasion the browser refuses the
  // request (e.g. the user Alt-Tabbed during composition); in that
  // case we fall through to the existing canvas-click re-lock path.
  const handleComposerClose = useCallback(() => {
    setComposer(null);
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Microtask delay so the pointerlockchange event from the
    // composer's open-time exitPointerLock settles before we
    // re-request. Without this, Chrome sometimes drops the second
    // request as "already in transition".
    queueMicrotask(() => {
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock?.();
      }
    });
  }, []);

  // When the canvas is clicked while Play is already ON but pointer
  // isn't locked (e.g. user released lock via a transient focus loss
  // and now wants back in), re-acquire.
  useEffect(() => {
    if (!playMode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onClick = () => {
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock?.();
      }
    };
    canvas.addEventListener('click', onClick);
    return () => canvas.removeEventListener('click', onClick);
  }, [playMode]);

  // Press V in Play mode → toggle the "show every feedback at once"
  // overlay. It's a latched on/off switch (not hold-to-reveal) so the
  // user can keep the overview visible while looking around with the
  // mouse — useful for the "where did everyone drop notes on this
  // map" browsing loop.
  //
  // Guards:
  //   - `e.repeat` is ignored so holding V doesn't flip the state
  //     over and over at the browser's auto-repeat rate.
  //   - `playModeState.inputSuppressed` blocks activation while the
  //     chat HUD or feedback composer has focus; otherwise typing
  //     the letter "v" would secretly toggle the overlay.
  //
  // Exit paths that auto-clear the flag:
  //   - Leaving Play mode (effect cleanup) — the overlay belongs to
  //     the in-session HUD, not the edit-mode surface.
  // We deliberately DO NOT reset on blur / pointer-lock change any
  // more: a toggle should persist across these transitions so the
  // user doesn't have to re-press V after alt-tabbing back in.
  useEffect(() => {
    if (!playMode) {
      setBubblesShowAllActive(false);
      return;
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code !== 'KeyV' && e.key !== 'v' && e.key !== 'V') return;
      if (playModeState.inputSuppressed) return;
      setBubblesShowAllActive(!isBubblesShowAllActive());
    };
    window.addEventListener('keydown', onDown);
    return () => {
      setBubblesShowAllActive(false);
      window.removeEventListener('keydown', onDown);
    };
  }, [playMode]);

  return (
    <div className="viewer-root">
      {/* Editor HUD + inspector live OUTSIDE of Play mode. Play mode
          is meant to feel like a first-class gameplay session, not a
          debug view, so we collapse every authoring affordance (scene
          metadata, collider toggles, debug render modes, rebake
          controls, the inspector panel, any picking outlines) and
          surface only the Play status strip with its Esc hint.
          Rendering is gated at the JSX level rather than via CSS
          `display:none` so the expensive inspector subtree (which
          includes selected-node traversal and per-mesh stats) isn't
          computed at all while the user is playing. */}
      {!playMode && (
      <div className="viewer-hud">
        <div className="title">{scene.name}</div>
        <div className="muted">{scene.relPath}</div>
        <div>
          GameObjects: <b>{scene.stats.totalGameObjects}</b> &middot; Meshes:{' '}
          <b>{scene.stats.renderedMeshes}</b> &middot; Lights: <b>{scene.stats.lights}</b>{' '}
          &middot; Materials: <b>{scene.stats.materials}</b> &middot; Cameras:{' '}
          <b>{scene.stats.cameras}</b> &middot; Prefabs:{' '}
          <b>{scene.stats.prefabInstances}</b> &middot; InlineMeshes:{' '}
          <b>{scene.stats.inlineMeshes}</b>
          {scene.renderSettings?.fogEnabled && (
            <>
              {' '}
              &middot; Fog: <b>{scene.renderSettings.fogMode}</b>
            </>
          )}
        </div>
        <div className="muted">
          FBX assets: <b>{fbx.ready}</b> ready &middot; <b>{fbx.pending}</b> loading &middot;{' '}
          {fbx.failed > 0 ? (
            <button
              type="button"
              onClick={() => setShowFbxFailures((v) => !v)}
              title="Show the specific GUIDs and failure reasons. Use this to tell whether you're looking at a server LFS issue (lfs-pointer dominant), a missing-asset indexing bug (missing/HTTP 404), or a parse regression (error)."
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: '#e67e7e',
                cursor: 'pointer',
                font: 'inherit',
                textDecoration: 'underline dotted',
              }}
            >
              <b>{fbx.failed}</b> failed
            </button>
          ) : (
            <>
              <b>{fbx.failed}</b> failed
            </>
          )}
          {' / '}
          {fbx.requested} requested
        </div>
        {showFbxFailures && fbx.failed > 0 && <FbxFailurePanel stats={fbx} />}
        <div className="muted">
          Bounds center: [{framing.center[0].toFixed(1)}, {framing.center[1].toFixed(1)},{' '}
          {framing.center[2].toFixed(1)}] &middot; radius: {framing.radius.toFixed(1)}
        </div>
        <div className="hud-toggle-row">
          <button
            type="button"
            className={`hud-toggle${showColliders ? ' on' : ''}`}
            onClick={() => setShowColliders((v) => !v)}
            title="Toggle visibility of collider-only sub-trees and disabled renderers (m_Enabled=0). Off by default — matches Unity's Game view."
          >
            {showColliders ? 'Colliders: ON' : 'Colliders: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugSubmeshColors ? ' on' : ''}`}
            onClick={() => setDebugSubmeshColors((v) => !v)}
            title="Paint every mesh with per-slot solid colors (slot 0 red, 1 green, 2 blue, 3 yellow, …) so you can see which geometry references which submesh slot. Textures and lighting are bypassed — diagnostic only."
          >
            {debugSubmeshColors ? 'Submesh colors: ON' : 'Submesh colors: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugUvCheckerboard ? ' on' : ''}`}
            onClick={() => setDebugUvCheckerboard((v) => !v)}
            title="Paint every mesh with a UV checkerboard (red=+U arrow, green=+V arrow, mirrored 'A' glyph). Squares=UVs uniform; rectangles=stretched; flipped A=mirrored UVs. Diagnostic only."
          >
            {debugUvCheckerboard ? 'UV checker: ON' : 'UV checker: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugUnlitPreview ? ' on' : ''}`}
            onClick={() => setDebugUnlitPreview((v) => !v)}
            title="Render every lit material as unlit (MeshBasicMaterial) with only its base map. Isolates UV/texture from PBR shading — if an atlas glyph (BATTLE ARENA) shows up here but not in normal render, the bug is in lighting/emission."
          >
            {debugUnlitPreview ? 'Unlit preview: ON' : 'Unlit preview: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugFlipYOff ? ' on' : ''}`}
            onClick={() => setDebugFlipYOff((v) => !v)}
            title="Force flipY=false on every texture. Detects double-flip bugs where the server-side decoder already orients the image for GL and three.js's default flipY=true inverts it again."
          >
            {debugFlipYOff ? 'flipY: OFF (forced)' : 'flipY: ON (default)'}
          </button>
        </div>
        <RebakeButton relPath={relPath} />
      </div>
      )}
      <Canvas
        key={scene.relPath}
        camera={{
          position: framing.cameraPos,
          fov: 50,
          near: framing.near,
          far: framing.far,
        }}
        // `preserveDrawingBuffer` is required for `canvas.toDataURL`
        // to return a non-blank image after present. We snapshot the
        // canvas when the user presses Enter to author feedback; the
        // frame-per-frame cost of keeping the back buffer around is
        // small and the feature is unusable without it.
        gl={{ preserveDrawingBuffer: true }}
        style={{ background: '#0b0d11' }}
        onCreated={({ gl }) => {
          // Capture the underlying DOM canvas so `enterPlay` can
          // request pointer lock on it inside the click handler.
          canvasRef.current = gl.domElement;
        }}
        onPointerMissed={(e) => {
          // Click on empty space deselects. r3f fires this when no mesh
          // intercepted the pointer. Filter to button 0 so camera drags
          // that end on empty space don't clobber the selection.
          // Suppressed in Play mode: clicks there are reserved for
          // pointer-lock re-acquisition and (eventually) shooting.
          if (playMode) return;
          if ((e as MouseEvent).button === 0) setSelection(null);
        }}
      >
        <DebugSceneHook />
        <CameraRefBridge cameraRef={cameraRef} />
        <Suspense fallback={null}>
          {/* SceneRoots instantiates the scene lights + ambient + fog
              internally so we don't duplicate them here. */}
          {/* Grid is a visual reference only — the wrapping group's
              `noCollide` keeps PlayerController's collision raycasts
              from treating it as a floor, even though drei renders
              it as a screen-facing mesh. */}
          <group userData={{ noCollide: true }}>
            <Grid
              args={[200, 200]}
              position={[0, framing.floorY, 0]}
              cellSize={Math.max(0.5, framing.radius / 40)}
              sectionSize={Math.max(5, framing.radius / 5)}
              cellThickness={0.6}
              sectionThickness={1.2}
              infiniteGrid
              fadeDistance={framing.radius * 6}
              fadeStrength={1}
              cellColor="#2a3242"
              sectionColor="#3c4a66"
            />
          </group>
          <SelectionProvider
            selectedGroupUuid={selection?.groupUuid ?? null}
            setSelection={setSelection}
          >
            <SceneRoots
              roots={scene.roots}
              inlineMeshes={scene.inlineMeshes}
              materials={scene.materials}
              fbxExternalMaterials={scene.fbxExternalMaterials}
              materialNameIndex={scene.materialNameIndex}
              renderSettings={scene.renderSettings}
              showColliders={showColliders}
              debugSubmeshColors={debugSubmeshColors}
              debugUvCheckerboard={debugUvCheckerboard}
              debugUnlitPreview={debugUnlitPreview}
              debugFlipYOff={debugFlipYOff}
              slotPermutations={slotPermutations}
            />
          </SelectionProvider>
          <OrbitControls
            ref={orbitRef}
            makeDefault={!playMode}
            enabled={!playMode}
            target={framing.center}
            minDistance={framing.radius * 0.1}
            maxDistance={framing.radius * 10}
          />
          <OrbitStateKeeper playMode={playMode} orbitRef={orbitRef} />
          {playMode && (
            <>
              <PlayerController
                ref={playerHandleRef}
                initialPose={initialPose}
              />
              {/* Aegis Stand_Default is the baseline: 2.3 m distance,
                  80° FOV, 0.45 m shoulder, 0.5 m vertical arm, 1.0 m
                  camera offset. Preset-driven so swapping to aim / ads
                  later is a one-line change. We intentionally don't
                  pass `initialDistance` so the preset's 2.3 m wins —
                  scene-radius heuristics are for the ORBITAL camera,
                  not the over-the-shoulder rig. */}
              <ShoulderCamera
                playerHandle={playerHandleRef}
                preset={aiming ? 'Stand_Aim' : 'Stand_Default'}
                crouching={crouching}
                initialPitch={initialPose.cameraPitch}
                initialYaw={initialPose.cameraYaw}
                recoilHandleRef={cameraRecoilRef}
              />
              {/* Hitscan LMG: LMB-hold fires while pointer is locked.
                  Tracers + impact markers live inside the shooter
                  component; `cameraRecoilRef` is populated by the
                  camera above and consumed here to kick the view on
                  each shot. */}
              <Shooter
                enabled={playMode}
                canvasRef={canvasRef}
                cameraRecoilRef={cameraRecoilRef}
              />
              {/* Broadcasts our local pose + animation state to the
                  multiplayer hub at ~20 Hz so other viewers' clients
                  can render our avatar walking around their scene. */}
              <LocalPoseBroadcaster
                playerHandleRef={playerHandleRef}
                playMode={playMode}
              />
            </>
          )}
          {/* Feedback pins — render in both play and edit modes so
              yesterday's feedback stays visible during tomorrow's
              walk-through. `scenePath` keys the list so switching
              scenes filters cleanly. */}
          <FeedbackPins scenePath={relPath} />
          {/* Remote-player avatars for everyone else currently in
              this scene's multiplayer room. Rendered at all times
              so edit-mode reviewers can see Play-mode reviewers
              walking around the map. */}
          <RemotePlayers />
          <axesHelper
            args={[Math.min(5, framing.radius * 0.1)]}
            userData={{ noCollide: true }}
          />
        </Suspense>
      </Canvas>
      {selection && !playMode && (
        <InspectorPanel
          selection={selection}
          materials={scene.materials}
          fbxExternalMaterials={scene.fbxExternalMaterials}
          materialNameIndex={scene.materialNameIndex}
          onClose={() => setSelection(null)}
          slotPermutations={slotPermutations}
          setSlotPermutation={setSlotPermutation}
          debugSubmeshColors={debugSubmeshColors}
        />
      )}
      {/* Service-style entry point. Intentionally separate from the
          debug toggle strip — Play mode is the headline feature of the
          viewer, not a diagnostic. Shown only when we're NOT already in
          Play mode. */}
      {!playMode && (
        <button
          type="button"
          className="play-fab"
          onClick={enterPlay}
          title="Enter Play mode — walk the level in third person (WASD, mouse look)"
        >
          <span className="play-fab-icon" aria-hidden>▶</span>
          <span className="play-fab-label">Play</span>
        </button>
      )}
      {/* In-session status strip. Thin, non-intrusive, always visible
          above the scene so the user remembers Esc ends the session. */}
      {playMode && (
        // Minimal strip — the only authoring affordance we keep in
        // Play mode is the Esc reminder + the Enter hint. Keeping the
        // Enter-to-feedback hint in the status strip is deliberate: a
        // pure no-UI clue for "press Enter to mark where you're
        // looking" would be invisible to anyone but us.
        <div className="play-status play-status-minimal">
          <span className="play-status-hint">Enter: 피드백 · V: 전체 보기 토글 · Esc: 나가기</span>
        </div>
      )}
      {/* Feedback panel — list of authored feedbacks, edit-mode only.
          Hidden during Play so it doesn't clutter the game view. */}
      {!playMode && <FeedbackPanel scenePath={relPath} />}
      {/* Floating preview card that appears when the Play-mode
          crosshair lands on a feedback pin. Gated to Play mode
          only — in editor mode the full FeedbackPanel is already
          visible on the side, so a second hover card would fight it
          for attention. */}
      {playMode && <FeedbackTooltip scenePath={relPath} />}
      {/* "Show every feedback at once" overlay — speech bubbles above
          every pin while the user holds V. Kept in the DOM (not R3F)
          so text is laid out by the browser's font stack and can be
          any length without blowing up GPU memory. */}
      {playMode && <FeedbackBubblesOverlay scenePath={relPath} />}
      {/* Multiplayer chat + presence HUD. Always visible (both Play
          and edit) so a lurker in edit mode can still talk to Play
          mode users and vice versa. Input field self-raises the
          same inputSuppressed flag the feedback composer uses so
          typing doesn't walk the character. */}
      <ChatHUD />
      {/* Feedback composer — HTML modal that takes the text body.
          Rendered outside the Canvas so it receives normal DOM
          focus / keyboard events. Closes via either submit or Esc;
          `handleComposerClose` re-requests pointer lock so the user
          lands back in Play mode. */}
      {composer && (
        <FeedbackComposer
          capture={composer}
          onClose={handleComposerClose}
        />
      )}
    </div>
  );
}

/**
 * HTML overlay that mirrors Unity's Inspector for the currently selected
 * GameObject. Deliberately flat/read-only — meant for side-by-side
 * comparison with the real Unity Inspector to diagnose transform, hierarchy,
 * or renderer binding discrepancies.
 */
function InspectorPanel({
  selection,
  materials,
  fbxExternalMaterials,
  materialNameIndex,
  onClose,
  slotPermutations,
  setSlotPermutation,
  debugSubmeshColors,
}: {
  selection: SceneSelection;
  materials?: Record<string, import('../lib/api').MaterialJson>;
  fbxExternalMaterials?: Record<string, Record<string, string>>;
  materialNameIndex?: Record<string, string>;
  onClose: () => void;
  slotPermutations: Record<string, number[]>;
  setSlotPermutation: (meshGuid: string, perm: number[] | null) => void;
  debugSubmeshColors: boolean;
}) {
  const { node, path, worldPosition, worldEulerDeg, worldScale } = selection;
  const t = node.transform;
  const q = t.quaternion;
  const eulerLocal = useMemo(() => {
    const quat = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    if (quat.lengthSq() < 1e-6) quat.identity();
    const e = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
    const RAD2DEG = 180 / Math.PI;
    return [e.x * RAD2DEG, e.y * RAD2DEG, e.z * RAD2DEG] as [number, number, number];
  }, [q]);

  const fmt = (n: number): string => n.toFixed(3);
  const fmt1 = (n: number): string => n.toFixed(1);

  return (
    <div className="inspector-panel">
      <div className="inspector-head">
        <div className="inspector-title">{node.name || '(unnamed)'}</div>
        <button type="button" className="inspector-close" onClick={onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="inspector-path" title={path.join(' / ')}>
        {path.length > 1 ? path.slice(0, -1).join(' / ') : '(root)'}
      </div>
      <div className="inspector-meta">
        fileID: <code>{node.fileID}</code>
        {!node.active && <span className="inspector-chip">inactive</span>}
        {node.isCollider && (
          <span className="inspector-chip collider" title="Hidden by default — this GameObject lives under a collider-only sub-tree. Use the HUD 'Colliders' toggle to show.">
            collider
          </span>
        )}
        {node.renderer && <span className="inspector-chip">MeshRenderer</span>}
        {node.renderer?.enabled === false && (
          <span className="inspector-chip collider" title="MeshRenderer.m_Enabled = 0 in the scene YAML; Unity would not draw this.">
            renderer disabled
          </span>
        )}
        {node.light && <span className="inspector-chip">Light ({node.light.type})</span>}
        {node.camera && <span className="inspector-chip">Camera</span>}
      </div>

      {/* Unity Inspector에 직접 붙여 비교할 수 있도록, 우리 내부 좌표계(Three,
          오른손)를 Unity 좌표계(왼손)로 되돌린 값을 함께 표시합니다.
          같은 이름의 prefab instance가 여러 개일 때 어느 인스턴스인지
          (position/scale/path) 로 빠르게 판별할 수 있어야 오브젝트 피킹이
          오인된 건지, 진짜 렌더링 버그인지 구분이 됩니다. */}
      <div className="inspector-section">Local Transform · Unity</div>
      <div className="inspector-row">
        <span className="inspector-label">Position</span>
        <span className="inspector-val">
          {fmt(-t.position[0])}, {fmt(t.position[1])}, {fmt(t.position[2])}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Rotation</span>
        <span className="inspector-val">
          {fmt1(eulerLocal[0])}°, {fmt1(-eulerLocal[1])}°, {fmt1(-eulerLocal[2])}°
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Scale</span>
        <span className="inspector-val">
          {fmt(t.scale[0])}, {fmt(t.scale[1])}, {fmt(t.scale[2])}
        </span>
      </div>

      <div className="inspector-section">World Transform · Unity</div>
      <div className="inspector-row">
        <span className="inspector-label">Position</span>
        <span className="inspector-val">
          {fmt(-worldPosition[0])}, {fmt(worldPosition[1])}, {fmt(worldPosition[2])}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Rotation</span>
        <span className="inspector-val">
          {fmt1(worldEulerDeg[0])}°, {fmt1(-worldEulerDeg[1])}°, {fmt1(-worldEulerDeg[2])}°
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Scale</span>
        <span className="inspector-val">
          {fmt(worldScale[0])}, {fmt(worldScale[1])}, {fmt(worldScale[2])}
        </span>
      </div>

      <div className="inspector-section">Local Transform · three.js (internal)</div>
      <div className="inspector-row">
        <span className="inspector-label">Position</span>
        <span className="inspector-val">
          {fmt(t.position[0])}, {fmt(t.position[1])}, {fmt(t.position[2])}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Rotation</span>
        <span className="inspector-val">
          {fmt1(eulerLocal[0])}°, {fmt1(eulerLocal[1])}°, {fmt1(eulerLocal[2])}°
        </span>
      </div>

      <div className="inspector-section">World Transform · three.js (internal)</div>
      <div className="inspector-row">
        <span className="inspector-label">Position</span>
        <span className="inspector-val">
          {fmt(worldPosition[0])}, {fmt(worldPosition[1])}, {fmt(worldPosition[2])}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Rotation</span>
        <span className="inspector-val">
          {fmt1(worldEulerDeg[0])}°, {fmt1(worldEulerDeg[1])}°, {fmt1(worldEulerDeg[2])}°
        </span>
      </div>

      <div className="inspector-hint">
        "Unity" 행은 왼손(Unity)좌표계로 환산한 값입니다. Unity Inspector 값과
        그대로 비교하세요. 동일한 이름이 여러 개라면 Hierarchy 경로(위)와
        world position까지 맞아떨어지는 인스턴스만 같은 객체입니다.
      </div>

      {node.renderer && (
        <>
          <div className="inspector-section">Renderer</div>
          <div className="inspector-row">
            <span className="inspector-label">Mesh</span>
            <span className="inspector-val">
              {node.renderer.meshName ?? '(inline)'}{' '}
              <code className="inspector-guid">{node.renderer.meshGuid ?? ''}</code>
            </span>
          </div>
          {(node.renderer.meshSubmeshName || node.renderer.meshFileID) && (
            <div className="inspector-row">
              <span className="inspector-label">Submesh</span>
              <span className="inspector-val">
                {node.renderer.meshSubmeshName ?? <em>(fallback to first)</em>}{' '}
                {node.renderer.meshFileID && (
                  <code className="inspector-guid">fileID {node.renderer.meshFileID}</code>
                )}
              </span>
            </div>
          )}
          {selection.meshInfo && (
            <>
              <div className="inspector-row">
                <span className="inspector-label">Geometry</span>
                <span className="inspector-val">
                  verts={selection.meshInfo.vertexCount} · UV
                  channels=<b>{selection.meshInfo.uvChannelCount}</b> · submesh groups=
                  <b>{selection.meshInfo.groupCount}</b>
                </span>
              </div>
              {(selection.pickUv || selection.pickFaceUvBounds) && (
                <div className="inspector-row">
                  <span className="inspector-label">Pick UV</span>
                  <span className="inspector-val">
                    {selection.pickUv && (
                      <code
                        className="inspector-guid"
                        title="UV0 at the exact ray-intersection point on the picked triangle. In [0,1] this is the atlas tile the shader samples at that pixel."
                      >
                        uv=({selection.pickUv[0].toFixed(3)},{' '}
                        {selection.pickUv[1].toFixed(3)})
                      </code>
                    )}
                    {selection.pickFaceUvBounds && (
                      <>
                        {' '}
                        <code
                          className="inspector-guid"
                          title="UV0 bounding box of the picked triangle's 3 vertices — the atlas sub-range this face samples"
                        >
                          face=({selection.pickFaceUvBounds[0].toFixed(3)}..
                          {selection.pickFaceUvBounds[2].toFixed(3)},{' '}
                          {selection.pickFaceUvBounds[1].toFixed(3)}..
                          {selection.pickFaceUvBounds[3].toFixed(3)})
                        </code>
                      </>
                    )}
                    {typeof selection.pickMaterialIndex === 'number' && (
                      <>
                        {' '}· slot <b>{selection.pickMaterialIndex}</b>
                      </>
                    )}
                  </span>
                </div>
              )}
              {selection.meshInfo.groups.length > 0 && (
                <div className="inspector-row">
                  <span className="inspector-label">Groups</span>
                  <span className="inspector-val">
                    {selection.meshInfo.groups.map(([s, c, m], i) => {
                      // Resolve what ACTUALLY got drawn on this group. The
                      // renderer snapshots its per-slot binding decision onto
                      // `mesh.userData.slotBindings`, keyed by slot = group's
                      // materialIndex. When `matName` here disagrees with
                      // what Unity's MeshRenderer Inspector shows at the
                      // same slot, we've found the "material order is right
                      // but drawing is wrong" bug: FBXLoader's group order
                      // diverged from Unity's submesh order, so Unity's
                      // m_Materials[m] got painted on geometry that Unity
                      // itself would draw with a different slot. The FBX-
                      // embedded name makes that divergence concrete.
                      const bind = selection.meshInfo?.slotBindings?.[m];
                      const fbxName = bind?.fbxEmbeddedName;
                      const uvBB = selection.meshInfo?.groupUvBounds?.[i];
                      return (
                        <div key={i} className="inspector-mat">
                          [{i}] start={s} count={c} → slot <b>{m}</b>
                          {uvBB && (
                            <>
                              {' '}
                              <code
                                className="inspector-guid"
                                title="UV0 bounding box (uMin..uMax, vMin..vMax) — pick the atlas tile this group samples"
                              >
                                uv=({uvBB[0].toFixed(3)}..{uvBB[2].toFixed(3)},{' '}
                                {uvBB[1].toFixed(3)}..{uvBB[3].toFixed(3)})
                              </code>
                            </>
                          )}
                          {bind && bind.matName && (
                            <>
                              {' '}· <b>{bind.matName}</b>
                              {bind.baseMapGuid && (
                                <>
                                  {' '}
                                  <code className="inspector-guid">
                                    tex:{bind.baseMapGuid}
                                  </code>
                                </>
                              )}
                            </>
                          )}
                          {fbxName && (
                            <>
                              {' '}
                              <span
                                className="inspector-chip-mini"
                                style={{
                                  color:
                                    bind?.matName &&
                                    fbxName.replace(/_M$/, '') !==
                                      bind.matName.replace(/_M$/, '')
                                      ? '#ffcf7a'
                                      : undefined,
                                }}
                                title="FBX-embedded material name at this slot"
                              >
                                fbx:{fbxName}
                              </span>
                            </>
                          )}
                        </div>
                      );
                    })}
                    {selection.meshInfo.groupCount > selection.meshInfo.groups.length && (
                      <div className="inspector-mat">
                        <em>… +{selection.meshInfo.groupCount - selection.meshInfo.groups.length} more</em>
                      </div>
                    )}
                  </span>
                </div>
              )}
            </>
          )}
          {node.renderer.meshGuid && node.renderer.materialGuids.length >= 2 && (
            <SlotPermutationEditor
              meshGuid={node.renderer.meshGuid}
              materialGuids={node.renderer.materialGuids}
              materials={materials}
              fbxRemap={
                fbxExternalMaterials?.[node.renderer.meshGuid.toLowerCase()] ??
                fbxExternalMaterials?.[node.renderer.meshGuid]
              }
              materialNameIndex={materialNameIndex}
              slotBindings={selection.meshInfo?.slotBindings}
              permutation={slotPermutations[node.renderer.meshGuid.toLowerCase()]}
              onChange={(perm) => setSlotPermutation(node.renderer!.meshGuid!, perm)}
              debugSubmeshColors={debugSubmeshColors}
            />
          )}
          <div className="inspector-row">
            <span className="inspector-label">Materials</span>
            <span className="inspector-val">
              {(() => {
                const allGuids = node.renderer.materialGuids;
                // Submesh groups authoritatively decide which slots matter.
                // When the mesh is loaded, clamp to `max(materialIndex) + 1`
                // so scene-authored slots beyond that (prefab padding,
                // leftover DM_PropSet entries inherited from variants) drop
                // out of the Inspector — mirroring what `materialList` now
                // emits in the renderer so the panel doesn't claim phantom
                // bindings Unity itself never samples.
                //
                // Before the geometry arrives (or for empty m_Materials)
                // `usedSlotCount` is 0; we fall back to the full list so
                // authoring mistakes (truly empty slot 0) stay visible.
                const used = selection.meshInfo?.usedSlotCount ?? 0;
                const visibleCount =
                  used > 0 && allGuids.length > 0
                    ? Math.min(used, allGuids.length)
                    : allGuids.length;
                const hidden = allGuids.length - visibleCount;
                const visible = allGuids.slice(0, visibleCount);
                if (allGuids.length === 0) return <em>none</em>;
                return (
                  <>
                    {visible.map((g, i) => {
                      // Narrow `m` to `MaterialJson | undefined`. Using
                      // `g && materials?.[g]` would leak the empty-string
                      // case of `g` into `m`'s type, and TS then refuses
                      // to let us read fields like `baseMapTiling` even
                      // through an optional chain — `?.` only short-circuits
                      // on null/undefined, not on `""`.
                      const m = g ? materials?.[g] : undefined;
                      const tile = m?.baseMapTiling;
                      const off = m?.baseMapOffset;
                      const fmt = (n: number): string => n.toFixed(2);
                      return (
                        <div key={i} className="inspector-mat">
                          [{i}] {m?.name ?? '(unresolved)'}
                          {m?.shaderKind && (
                            <span className="inspector-chip-mini">{m.shaderKind}</span>
                          )}
                          <br />
                          <code className="inspector-guid">{g ?? 'null'}</code>
                          {m && (
                            <div className="inspector-mat-detail">
                              baseMap={m.baseMapGuid ? (
                                <code className="inspector-guid">
                                  {m.baseMapGuid.slice(0, 8)}
                                </code>
                              ) : (
                                <em>none</em>
                              )}
                              {' · '}tile=
                              <b
                                style={{
                                  color:
                                    tile && (tile[0] !== 1 || tile[1] !== 1)
                                      ? '#ffcf7a'
                                      : undefined,
                                }}
                              >
                                {tile ? `(${fmt(tile[0])}, ${fmt(tile[1])})` : '(1, 1)'}
                              </b>
                              {' · '}off=
                              <b
                                style={{
                                  color:
                                    off && (off[0] !== 0 || off[1] !== 0)
                                      ? '#ffcf7a'
                                      : undefined,
                                }}
                              >
                                {off ? `(${fmt(off[0])}, ${fmt(off[1])})` : '(0, 0)'}
                              </b>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {hidden > 0 && (
                      <div className="inspector-mat inspector-mat-dead">
                        <em>
                          … +{hidden} unused slot{hidden > 1 ? 's' : ''} (authored in scene,
                          no submesh samples them)
                        </em>
                      </div>
                    )}
                  </>
                );
              })()}
            </span>
          </div>
        </>
      )}
      {node.light && (
        <>
          <div className="inspector-section">Light</div>
          <div className="inspector-row">
            <span className="inspector-label">Type</span>
            <span className="inspector-val">{node.light.type}</span>
          </div>
          <div className="inspector-row">
            <span className="inspector-label">Color</span>
            <span className="inspector-val">
              {fmt(node.light.color[0])}, {fmt(node.light.color[1])}, {fmt(node.light.color[2])}
            </span>
          </div>
          <div className="inspector-row">
            <span className="inspector-label">Intensity</span>
            <span className="inspector-val">{fmt(node.light.intensity)}</span>
          </div>
          {(node.light.type === 'Point' || node.light.type === 'Spot') && (
            <div className="inspector-row">
              <span className="inspector-label">Range</span>
              <span className="inspector-val">{fmt(node.light.range ?? 0)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface Framing {
  center: [number, number, number];
  cameraPos: [number, number, number];
  radius: number;
  near: number;
  far: number;
  floorY: number;
}

/**
 * Inspector sub-panel that lets the user re-order the material slots for
 * the selected FBX. Renders one dropdown per slot (capped at 16 to avoid
 * pathological cases), each picking an index into the original
 * `m_Materials` array — so the dropdown values are "what does this slot
 * *now* sample from m_Materials". Applying the identity permutation
 * `[0,1,…,N-1]` is equivalent to clearing the override.
 *
 * Why an editor instead of auto-detection: when Unity's submesh ordering
 * and three.js FBXLoader's `group.materialIndex` ordering disagree there's
 * no name-based signal to lean on (3ds Max-exported FBXs name their
 * materials `MATERIAL #4099`, `#597`, …). The reliable way to find the
 * right permutation is to let a human look at the scene and say "walls
 * should be blue" — this UI makes that experiment a one-click action.
 *
 * Per-FBX (keyed by meshGuid), not per-instance: every scene placement of
 * the same FBX shares one permutation. Matches Unity's own remap granular-
 * ity and prevents the same experiment from fragmenting across hundreds of
 * placements.
 */
function SlotPermutationEditor({
  meshGuid,
  materialGuids,
  materials,
  fbxRemap,
  materialNameIndex,
  slotBindings,
  permutation,
  onChange,
  debugSubmeshColors,
}: {
  meshGuid: string;
  materialGuids: string[];
  materials?: Record<string, import('../lib/api').MaterialJson>;
  /** ModelImporter.externalObjects remap for this FBX: FBX-embedded
   *  material name -> external `.mat` GUID. Used by the Auto button to
   *  compute the correct permutation by GUID-matching each submesh's
   *  FBX-intended material against Unity's scene-level m_Materials. */
  fbxRemap?: Record<string, string>;
  /** Project-wide `.mat` name → GUID index. Used as a fallback when the
   *  FBX `.meta` has `externalObjects: {}` but `materialSearch: 1`
   *  (Recursive-Up) + `materialName: 0` (From Model's Material) — Unity
   *  resolves each FBX-embedded material name by project-wide search, and
   *  we mirror that here. */
  materialNameIndex?: Record<string, string>;
  /** Per-slot bindings snapshotted at selection time. We need the
   *  `fbxEmbeddedName` to drive Auto-detect. */
  slotBindings?: import('../lib/sceneToR3F').MeshInfoSnapshot['slotBindings'];
  permutation: number[] | undefined;
  onChange: (perm: number[] | null) => void;
  debugSubmeshColors: boolean;
}) {
  const slotCount = Math.min(materialGuids.length, 16);
  const current: number[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    const src = permutation?.[i];
    current.push(typeof src === 'number' && src >= 0 && src < slotCount ? src : i);
  }

  const isIdentity = current.every((v, i) => v === i);

  // Compute what Unity's material binding WOULD be if we followed the FBX
  // ModelImporter's externalObjects remap (Unity's authored name->GUID
  // table) instead of the scene's positional m_Materials[] binding.
  //
  // The permutation editor's default assumption is: FBXLoader's submesh N
  // ↔ Unity's m_Materials[N]. That breaks when FBXLoader's material array
  // order diverges from Unity's import-time binding order (common for
  // FBXs authored in Max/Maya where the material ordering in the binary
  // doesn't match Unity's ordering after externalObjects remap).
  //
  // For each FBX slot N, we look up the embedded material name in the
  // remap table to find its "intended" .mat GUID G, then locate G in
  // materialGuids[] to find Unity's true slot index J. perm[N]=J then
  // routes the right material to the right submesh.
  //
  // Returns null when auto-detect is not actionable (missing inputs,
  // remap doesn't resolve for every slot, or the computed permutation
  // is identity — same as default, nothing to apply).
  const autoDiagnosis = useMemo<{
    permutation: number[] | null;
    /** Non-null whenever the Auto button is unavailable; explains why so
     *  the user isn't left guessing why the button never appears. */
    reason: string | null;
    /** Per-slot breakdown shown under the button for transparency. */
    perSlot: Array<{
      fbxName: string;
      resolvedGuid: string;
      /** Where the GUID came from: externalObjects remap, project-wide
       *  name index (Unity materialSearch: Recursive-Up), or neither. */
      source: 'remap' | 'name-index' | 'none';
      matchedSlot: number | null;
    }>;
  }>(() => {
    const perSlot: Array<{
      fbxName: string;
      resolvedGuid: string;
      source: 'remap' | 'name-index' | 'none';
      matchedSlot: number | null;
    }> = [];
    if (!slotBindings || slotBindings.length === 0) {
      return { permutation: null, reason: 'slotBindings not available yet (mesh still loading?)', perSlot };
    }
    const remapHasEntries = fbxRemap && Object.keys(fbxRemap).length > 0;
    const nameIndexHasEntries =
      materialNameIndex && Object.keys(materialNameIndex).length > 0;
    if (!remapHasEntries && !nameIndexHasEntries) {
      return {
        permutation: null,
        reason: `Neither FBX externalObjects remap nor project-wide .mat name index is available for ${meshGuid.slice(0, 8)}`,
        perSlot,
      };
    }
    const guidToSlot = new Map<string, number>();
    for (let j = 0; j < materialGuids.length; j += 1) {
      const g = (materialGuids[j] ?? '').toLowerCase();
      if (g && !guidToSlot.has(g)) guidToSlot.set(g, j);
    }
    // Build a case-insensitive view of the materialNameIndex so embedded
    // FBX names (which might differ in case from .mat asset names) still
    // resolve. First exact match wins.
    const nameIndexCI = new Map<string, string>();
    if (nameIndexHasEntries) {
      for (const [name, guid] of Object.entries(materialNameIndex!)) {
        if (!name || !guid) continue;
        const key = name.toLowerCase();
        if (!nameIndexCI.has(key)) nameIndexCI.set(key, guid.toLowerCase());
      }
    }
    const resolveName = (name: string): { guid: string; source: 'remap' | 'name-index' | 'none' } => {
      if (!name) return { guid: '', source: 'none' };
      if (remapHasEntries) {
        const g = (fbxRemap![name] ?? '').toLowerCase();
        if (g) return { guid: g, source: 'remap' };
      }
      if (nameIndexHasEntries) {
        // Unity's materialName: 0 ("From Model's Material") uses the FBX
        // embedded name verbatim. Try exact, then common suffix variants
        // Max/Maya pipelines apply (e.g. "_M" for Material asset naming).
        const tries = [name, `${name}_M`, `${name}_mat`, name.replace(/_M$/i, '')];
        for (const t of tries) {
          const g = nameIndexCI.get(t.toLowerCase());
          if (g) return { guid: g, source: 'name-index' };
        }
      }
      return { guid: '', source: 'none' };
    };
    const perm: number[] = [];
    let firstFailReason: string | null = null;
    for (let i = 0; i < slotCount; i += 1) {
      const b = slotBindings[i];
      const fbxName = b?.fbxEmbeddedName ?? '';
      const { guid: resolvedGuid, source } = resolveName(fbxName);
      const matchedSlot = resolvedGuid ? (guidToSlot.get(resolvedGuid) ?? null) : null;
      perSlot.push({ fbxName, resolvedGuid, source, matchedSlot });
      if (!fbxName) {
        firstFailReason = firstFailReason ?? `slot ${i} has no FBX-embedded name`;
        perm.push(i);
        continue;
      }
      if (!resolvedGuid) {
        // 3ds Max exports materials with internal node IDs as names
        // ("Material #500", "Material #4099"). Those are meaningless
        // outside the FBX binary and cannot be mapped to a `.mat` file
        // by any name-based lookup. Call this out specifically so the
        // user knows Auto-detect is fundamentally impossible for this
        // FBX and falls back to the cyclic-shift helpers below.
        const isAnonMaxId = /^Material\s*#\d+$/i.test(fbxName);
        firstFailReason =
          firstFailReason ??
          (isAnonMaxId
            ? `slot ${i}: FBX name "${fbxName}" is a 3ds Max internal node ID (not a real material name). Use the Cycle ↻/↺ buttons to brute-force the correct slot rotation.`
            : `slot ${i}: FBX name "${fbxName}" not resolved via externalObjects remap nor project-wide .mat search`);
        perm.push(i);
        continue;
      }
      if (matchedSlot === null) {
        firstFailReason =
          firstFailReason ??
          `slot ${i}: resolved GUID ${resolvedGuid.slice(0, 8)} (via ${source}) not present in scene m_Materials[]`;
        perm.push(i);
        continue;
      }
      perm.push(matchedSlot);
    }
    if (firstFailReason) {
      return { permutation: null, reason: firstFailReason, perSlot };
    }
    const allIdentity = perm.every((v, k) => v === k);
    if (allIdentity) {
      return {
        permutation: null,
        reason: 'Computed permutation equals the identity — Unity and FBXLoader agree on ordering for this FBX',
        perSlot,
      };
    }
    return { permutation: perm, reason: null, perSlot };
  }, [fbxRemap, materialNameIndex, slotBindings, materialGuids, slotCount, meshGuid]);

  const autoPermutation = autoDiagnosis.permutation;
  const autoDiffersFromCurrent =
    autoPermutation !== null &&
    (autoPermutation.length !== current.length ||
      autoPermutation.some((v, i) => v !== current[i]));

  const setSlotSource = (slotIdx: number, newSrc: number) => {
    const next = current.slice();
    next[slotIdx] = newSrc;
    const allIdentity = next.every((v, i) => v === i);
    onChange(allIdentity ? null : next);
  };

  const swapWithNeighbor = (i: number, j: number) => {
    const next = current.slice();
    [next[i], next[j]] = [next[j], next[i]];
    const allIdentity = next.every((v, k) => v === k);
    onChange(allIdentity ? null : next);
  };

  // Determine how many leading slots are actually "populated" — i.e. the
  // FBX bound a non-empty embedded name. Trailing empty slots usually
  // come from scene-authored m_Materials padding that never reaches an
  // actual submesh, so we exclude them from cyclic rotations to avoid
  // scrambling the indices that matter.
  const populatedCount = (() => {
    if (!slotBindings || slotBindings.length === 0) return slotCount;
    let n = 0;
    for (let i = 0; i < slotCount; i += 1) {
      if ((slotBindings[i]?.fbxEmbeddedName ?? '') !== '') n = i + 1;
    }
    // Fall back to full range if no slot had an embedded name (can't
    // tell which are padding vs real, so let the user rotate all).
    return n === 0 ? slotCount : n;
  })();

  /** Cyclically shift the first `populatedCount` slots by `delta`. Positive
   *  delta means "slot 0 picks up the material that slot `delta` used to
   *  have" — i.e. forward rotation. [0,1,2,3,4,5,6] with delta=1 and
   *  populatedCount=3 → [1,2,0,3,4,5,6], which matches the `[1,2,0,3,...]`
   *  permutation the user manually discovered fixes DM_BLDG_ATeam_A. */
  const cycleShift = (delta: number) => {
    if (populatedCount <= 1) return;
    const next = current.slice();
    const window = next.slice(0, populatedCount);
    const n = window.length;
    const d = ((delta % n) + n) % n;
    const shifted = window.slice(d).concat(window.slice(0, d));
    for (let i = 0; i < n; i += 1) next[i] = shifted[i];
    const allIdentity = next.every((v, k) => v === k);
    onChange(allIdentity ? null : next);
  };

  const matLabel = (idx: number): string => {
    const g = materialGuids[idx];
    if (!g) return `[${idx}] (unresolved)`;
    const m = g && materials ? materials[g] : undefined;
    return `[${idx}] ${m?.name ?? g.slice(0, 8)}`;
  };

  return (
    <div className="inspector-row">
      <span className="inspector-label">Slot remap</span>
      <span className="inspector-val">
        <div className="inspector-mat-detail" style={{ marginBottom: 4 }}>
          Override which `m_Materials[N]` feeds each submesh slot. Same FBX
          ({meshGuid.slice(0, 8)}) across every instance. Groups are
          auto-reordered at FBX load time to match Unity's first-appearance
          submesh ordering, so the default (identity) permutation should be
          correct — use these controls only as a diagnostic fallback.
        </div>
        {current.map((src, i) => (
          <div
            key={i}
            className="inspector-mat"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span
              title={`Slot ${i} palette color in debug-submesh mode`}
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: DEBUG_SLOT_PALETTE[i % DEBUG_SLOT_PALETTE.length],
                outline: debugSubmeshColors ? '1px solid #fff' : 'none',
              }}
            />
            <span>slot {i} ←</span>
            <select
              value={src}
              onChange={(e) => setSlotSource(i, Number(e.target.value))}
              style={{ flex: 1 }}
            >
              {materialGuids.slice(0, slotCount).map((_g, idx) => (
                <option key={idx} value={idx}>
                  {matLabel(idx)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="hud-toggle"
              disabled={i === 0}
              onClick={() => swapWithNeighbor(i, i - 1)}
              title="Swap with slot above"
              style={{ padding: '0 6px' }}
            >
              ↑
            </button>
            <button
              type="button"
              className="hud-toggle"
              disabled={i === slotCount - 1}
              onClick={() => swapWithNeighbor(i, i + 1)}
              title="Swap with slot below"
              style={{ padding: '0 6px' }}
            >
              ↓
            </button>
          </div>
        ))}
        <div className="inspector-mat-detail" style={{ marginTop: 6, lineHeight: 1.4 }}>
          <div>
            <b>Auto-detect:</b>{' '}
            {autoPermutation ? (
              <>
                <code className="inspector-guid">[{autoPermutation.join(', ')}]</code>{' '}
                <span style={{ color: '#7ad4ff' }}>available</span>
              </>
            ) : (
              <span style={{ color: '#ffcf7a' }}>not actionable</span>
            )}
          </div>
          {autoDiagnosis.reason && (
            <div style={{ color: '#ffcf7a', fontSize: 11 }}>
              reason: {autoDiagnosis.reason}
            </div>
          )}
          {autoDiagnosis.perSlot.length > 0 && (
            <div style={{ fontSize: 11, marginTop: 2 }}>
              {autoDiagnosis.perSlot.map((r, i) => (
                <div key={i}>
                  slot {i}: fbx=<code className="inspector-guid">{r.fbxName || '(empty)'}</code>
                  {' → '}
                  {r.resolvedGuid ? (
                    <>
                      <code className="inspector-guid">{r.resolvedGuid.slice(0, 8)}</code>
                      <span
                        style={{
                          color: r.source === 'remap' ? '#7ad4ff' : '#b4e47a',
                          marginLeft: 4,
                        }}
                      >
                        ({r.source})
                      </span>
                    </>
                  ) : (
                    <span style={{ color: '#ffcf7a' }}>no match</span>
                  )}
                  {' → '}
                  {r.matchedSlot !== null ? (
                    <b>m_Materials[{r.matchedSlot}]</b>
                  ) : (
                    <span style={{ color: '#ffcf7a' }}>no m_Materials match</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            type="button"
            className="hud-toggle"
            disabled={isIdentity}
            onClick={() => onChange(null)}
            title="Restore Unity's default slot assignment for this FBX"
          >
            Reset
          </button>
          <button
            type="button"
            className="hud-toggle"
            onClick={() => {
              // Reverse is the single most useful one-click probe when the
              // Unity/FBXLoader disagreement is a straight flip of the
              // material list (which happens for certain Max exports).
              const rev = current.slice().reverse();
              const allIdentity = rev.every((v, k) => v === k);
              onChange(allIdentity ? null : rev);
            }}
            title="Reverse the current slot order ([0,1,2,3] → [3,2,1,0])"
          >
            Reverse
          </button>
          {autoPermutation && (
            <button
              type="button"
              className={`hud-toggle${autoDiffersFromCurrent ? ' on' : ''}`}
              disabled={!autoDiffersFromCurrent}
              onClick={() => onChange(autoPermutation)}
              title={`Apply name-based permutation derived from the FBX ModelImporter externalObjects remap. Computed: [${autoPermutation.join(', ')}]`}
            >
              Auto [{autoPermutation.join(',')}]
            </button>
          )}
          <button
            type="button"
            className="hud-toggle"
            disabled={populatedCount <= 1}
            onClick={() => cycleShift(1)}
            title={`Forward cyclic shift on first ${populatedCount} slot(s): [0,1,2,...] → [1,2,0,...]. Click repeatedly to explore all rotations.`}
          >
            Cycle ↻
          </button>
          <button
            type="button"
            className="hud-toggle"
            disabled={populatedCount <= 1}
            onClick={() => cycleShift(-1)}
            title={`Reverse cyclic shift on first ${populatedCount} slot(s): [0,1,2,...] → [2,0,1,...].`}
          >
            Cycle ↺
          </button>
          {!isIdentity && (
            <span
              className="inspector-chip-mini"
              style={{ alignSelf: 'center', color: '#ffcf7a' }}
              title="This FBX is using a manual slot remap"
            >
              overridden: [{current.join(', ')}]
            </span>
          )}
        </div>
      </span>
    </div>
  );
}

/**
 * React hook that mirrors the global FBX cache counters into component state.
 * Lets the HUD show a live "X of Y FBX assets ready" indicator without having
 * to poll — the fbxCache publishes synchronously whenever a fetch settles.
 */
function useFbxCacheStats(): FbxCacheStats {
  const [stats, setStats] = useState<FbxCacheStats>(() => ({
    requested: 0,
    pending: 0,
    ready: 0,
    failed: 0,
  }));
  useEffect(() => subscribeFbxCacheStats(setStats), []);
  return stats;
}

/**
 * HUD sub-panel that shows the per-GUID failure list when the user clicks the
 * "N failed" badge. Diagnoses the common "some meshes are missing on deploy"
 * triage question: was it LFS (server host didn't run `git lfs pull`), a
 * missing asset index entry, a network error, or a parse exception?
 *
 * The panel re-pulls `getFbxFailures()` whenever the aggregate stats change,
 * which happens synchronously on every settle. We don't keep the failures in
 * React state directly because (a) the list is often <10 entries and
 * reproducing it from the map is O(n), and (b) we want the HUD reactive to
 * both new failures landing AND existing ones being cleared by the
 * lfs-cooldown retry path in `loadFbx`.
 */
function FbxFailurePanel({ stats }: { stats: FbxCacheStats }): JSX.Element {
  const [failures, setFailures] = useState<FbxFailure[]>(() => getFbxFailures());
  useEffect(() => {
    setFailures(getFbxFailures());
  }, [stats.failed, stats.ready, stats.requested]);

  const byStatus: Record<string, number> = {};
  for (const f of failures) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  const breakdown = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v}× ${k}`)
    .join(', ');
  const DOMINANT_LFS_RATIO = 0.5;
  const showLfsHint =
    failures.length > 0 && (byStatus['lfs-pointer'] ?? 0) / failures.length > DOMINANT_LFS_RATIO;

  return (
    <div
      className="muted"
      style={{
        background: 'rgba(0,0,0,0.35)',
        border: '1px solid rgba(230,126,126,0.4)',
        borderRadius: 4,
        padding: '6px 8px',
        marginTop: 4,
        maxHeight: 220,
        overflow: 'auto',
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 11,
      }}
    >
      <div style={{ marginBottom: 4 }}>
        Failure breakdown: <b>{breakdown}</b>
        {showLfsHint && (
          <div style={{ color: '#ffcf73', marginTop: 2 }}>
            Most failures are LFS-pointer timeouts. This usually means the server host could not
            materialise Git LFS blobs in time. Check <code>/api/lfs-status</code>; on deploy
            verify <code>git-lfs</code> is installed and LFS credentials are configured.
          </div>
        )}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.7 }}>
            <th style={{ padding: '2px 6px' }}>guid</th>
            <th style={{ padding: '2px 6px' }}>status</th>
            <th style={{ padding: '2px 6px' }}>attempts</th>
            <th style={{ padding: '2px 6px' }}>reason</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((f) => (
            <tr key={f.guid} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={{ padding: '2px 6px' }} title={f.guid}>
                {f.guid.slice(0, 8)}
              </td>
              <td
                style={{
                  padding: '2px 6px',
                  color: f.status === 'lfs-pointer' ? '#ffcf73' : '#e67e7e',
                }}
              >
                {f.status}
              </td>
              <td style={{ padding: '2px 6px' }}>{f.attempts}</td>
              <td
                style={{
                  padding: '2px 6px',
                  maxWidth: 280,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={f.reason}
              >
                {f.reason ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Compute a bounding sphere from all transform positions in the scene so the
 * initial camera frames the content rather than sitting at a fixed 10,10,10
 * that might be thousands of units away from where the GameObjects actually
 * live.
 */
function computeFraming(roots: GameObjectNode[]): Framing {
  const bbox = new THREE.Box3();
  bbox.makeEmpty();
  const scratch = new THREE.Vector3();
  let count = 0;

  const visit = (
    node: GameObjectNode,
    parentMatrix: THREE.Matrix4,
  ): void => {
    const local = new THREE.Matrix4();
    const pos = new THREE.Vector3(
      node.transform.position[0],
      node.transform.position[1],
      node.transform.position[2],
    );
    const quat = new THREE.Quaternion(
      node.transform.quaternion[0],
      node.transform.quaternion[1],
      node.transform.quaternion[2],
      node.transform.quaternion[3],
    );
    if (quat.lengthSq() < 1e-6) quat.identity();
    const scale = new THREE.Vector3(
      node.transform.scale[0],
      node.transform.scale[1],
      node.transform.scale[2],
    );
    local.compose(pos, quat, scale);
    const worldMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, local);

    scratch.setFromMatrixPosition(worldMatrix);
    if (Number.isFinite(scratch.x) && Number.isFinite(scratch.y) && Number.isFinite(scratch.z)) {
      bbox.expandByPoint(scratch);
      count += 1;
    }
    for (const c of node.children) visit(c, worldMatrix);
  };

  const root = new THREE.Matrix4().identity();
  for (const r of roots) visit(r, root);

  if (count === 0 || bbox.isEmpty()) {
    return {
      center: [0, 0, 0],
      cameraPos: [10, 10, 10],
      radius: 10,
      near: 0.1,
      far: 1000,
      floorY: 0,
    };
  }

  const size = new THREE.Vector3();
  bbox.getSize(size);
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  const radius = Math.max(size.length() * 0.5, 1);
  const dist = radius * 2.2;

  return {
    center: [center.x, center.y, center.z],
    cameraPos: [center.x + dist, center.y + dist * 0.7, center.z + dist],
    radius,
    near: Math.max(0.01, radius * 0.01),
    far: Math.max(1000, radius * 50),
    floorY: bbox.min.y,
  };
}

function decodeSplat(s: string): string {
  return s
    .split('/')
    .map((seg) => seg)
    .join('/');
}

// ===========================================================================
// Unity high-fidelity viewer
// ===========================================================================

function UnityExportCanvas({ scene, relPath }: { scene: UnityExport; relPath: string }) {
  const stats = useMemo(() => getUnityExportStats(scene), [scene]);
  const framingRaw = useMemo(() => computeUnityExportFraming(scene), [scene]);

  // Baked-preview path doesn't have PlayerController / Play mode yet,
  // but we still join the multiplayer room so users browsing the
  // high-fidelity preview can chat and receive realtime feedback
  // events alongside reviewers using the YAML viewer.
  useEffect(() => {
    ensureConnected();
    setCurrentScene(relPath);
    return () => {
      setCurrentScene('');
    };
  }, [relPath]);

  // Same diagnostic toggles as the YAML path — baked Unity exports still
  // exhibit the "materials look wrong" symptom when UVs or submesh ordering
  // are off, so the same visualizations apply here.
  const [debugSubmeshColors, setDebugSubmeshColors] = useState(false);
  const [debugUvCheckerboard, setDebugUvCheckerboard] = useState(false);

  const radius = framingRaw.radius;
  const center: [number, number, number] = framingRaw.center;
  const dist = radius * 2.2;
  const cameraPos: [number, number, number] = [
    center[0] + dist,
    center[1] + dist * 0.7,
    center[2] + dist,
  ];

  return (
    <div className="viewer-root">
      <div className="viewer-hud">
        <div className="title">
          {scene.sceneName} <span className="muted">(high-fidelity)</span>
        </div>
        <div className="muted">{scene.scenePath}</div>
        <div>
          Nodes: <b>{stats.totalGameObjects}</b> &middot; Meshes:{' '}
          <b>{stats.renderedMeshes}</b>/<b>{stats.meshes}</b> &middot; Materials:{' '}
          <b>{stats.materials}</b> &middot; Lights: <b>{stats.lights}</b> &middot; Textures:{' '}
          <b>{stats.textures}</b>
        </div>
        <div className="muted">
          Bounds center: [{center[0].toFixed(1)}, {center[1].toFixed(1)}, {center[2].toFixed(1)}]{' '}
          &middot; radius: {radius.toFixed(1)} &middot; Fog:{' '}
          <b>{scene.render.fogEnabled ? scene.render.fogMode : 'off'}</b>
        </div>
        <div className="hud-toggle-row">
          <button
            type="button"
            className={`hud-toggle${debugSubmeshColors ? ' on' : ''}`}
            onClick={() => setDebugSubmeshColors((v) => !v)}
            title="Paint every mesh with per-slot solid colors to verify submesh ordering"
          >
            {debugSubmeshColors ? 'Submesh colors: ON' : 'Submesh colors: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugUvCheckerboard ? ' on' : ''}`}
            onClick={() => setDebugUvCheckerboard((v) => !v)}
            title="Paint every mesh with a UV checkerboard (+U arrow red, +V arrow green, 'A' glyph for orientation) to diagnose UV stretching / rotation / mirroring"
          >
            {debugUvCheckerboard ? 'UV checker: ON' : 'UV checker: OFF'}
          </button>
        </div>
        <RebakeButton relPath={relPath} />
      </div>
      <Canvas
        key={scene.scenePath}
        camera={{
          position: cameraPos,
          fov: 50,
          near: Math.max(0.01, radius * 0.01),
          far: Math.max(1000, radius * 50),
        }}
        shadows={false}
        style={{ background: '#0b0d11' }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <Suspense fallback={null}>
          <UnityRenderSettingsApply scene={scene} />
          {/* Fill light so the scene isn't pitch-black in areas the
              exported directional lights don't cover. Tier 2 will replace
              this with baked lightmaps. */}
          <hemisphereLight args={[0x8fa8c8, 0x2a2520, 0.4]} />
          <Grid
            args={[200, 200]}
            position={[0, center[1] - radius, 0]}
            cellSize={Math.max(0.5, radius / 40)}
            sectionSize={Math.max(5, radius / 5)}
            cellThickness={0.6}
            sectionThickness={1.2}
            infiniteGrid
            fadeDistance={radius * 6}
            fadeStrength={1}
            cellColor="#2a3242"
            sectionColor="#3c4a66"
          />
          <UnityExportRoots
            scene={scene}
            debugSubmeshColors={debugSubmeshColors}
            debugUvCheckerboard={debugUvCheckerboard}
          />
          <OrbitControls
            makeDefault
            target={center}
            minDistance={radius * 0.05}
            maxDistance={radius * 10}
          />
          <axesHelper args={[Math.min(5, radius * 0.1)]} />
        </Suspense>
      </Canvas>
      <ChatHUD />
    </div>
  );
}

/**
 * Floating button in the HUD that fires `/api/rebake` for the current scene
 * and polls the server for status until the export finishes. On success it
 * reloads the page so the freshly baked JSON is picked up.
 */
function RebakeButton({ relPath }: { relPath: string }) {
  const [status, setStatus] = useState<BatchStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRebakeStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const running = status?.state === 'running';

  useEffect(() => {
    if (!running) return;
    // Poll every 3s while a bake is in flight. Once the server transitions
    // to success we reload the page so the new baked JSON is served.
    const tick = setInterval(async () => {
      try {
        const s = await fetchRebakeStatus();
        setStatus(s);
        if (s.state === 'success' && s.relPath === relPath) {
          clearInterval(tick);
          window.location.reload();
        }
        if (s.state === 'failed') {
          clearInterval(tick);
        }
      } catch {
        /* ignore transient network errors */
      }
    }, 3000);
    return () => clearInterval(tick);
  }, [running, relPath]);

  const onClick = async () => {
    try {
      const resp = await triggerRebake(relPath);
      setStatus(resp.status);
    } catch (err) {
      alert('Rebake failed to queue: ' + (err as Error).message);
    }
  };

  const label = running
    ? `Baking... (${status?.relPath ?? relPath})`
    : status?.state === 'failed'
      ? `Rebake (last: failed — ${status.error ?? 'see server logs'})`
      : 'Rebake (high-fidelity)';

  return (
    <button
      type="button"
      disabled={running}
      onClick={onClick}
      style={{
        marginTop: 6,
        padding: '4px 10px',
        fontSize: 12,
        background: running ? '#2a3242' : '#1e4d8b',
        border: '1px solid #3c4a66',
        color: 'white',
        borderRadius: 4,
        cursor: running ? 'wait' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}
