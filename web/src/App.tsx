import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { apiGet, apiPost, publicAsset } from './lib/api';
import { ensureConnected } from './lib/multiplayer';
import { NicknameBadge } from './lib/NicknameBadge';

/** Runtime mode reported by /api/health. 'live' talks to GitLab +
 *  parses scenes on demand; 'bundle' only reads a pre-baked content
 *  pack and refuses any GitLab-touching API (sync / rebake return
 *  501). We render the header differently for each — in bundle mode
 *  the Sync button would be a dead end, so we hide it entirely. */
type ServerMode = 'live' | 'bundle';

interface HealthResponse {
  ok: boolean;
  mode: ServerMode;
}

/** Shape returned by `/api/lfs-status`. Combines two pieces of state:
 *  the root fields describe the bulk `.mat` + image prefetch (from
 *  `lazyLfs.BulkProgress`), and `sync` describes the in-flight manual
 *  Git Sync (from the server's `SyncState`). */
interface LfsStatus {
  running: boolean;
  total: number;
  done: number;
  filesDone: number;
  startedAt?: number;
  lastError?: string;
  sync?: {
    running: boolean;
    startedAt?: number;
    finishedAt?: number;
    action?: string;
    head?: string;
    error?: string;
  };
}

export default function App() {
  const loc = useLocation();
  const nav = useNavigate();
  const atHome = loc.pathname === '/';
  const [syncing, setSyncing] = useState(false);
  // `null` = still probing. Keeping the Sync button hidden until
  // we know the mode avoids a flash-of-useless-button on slow
  // cold boots in bundle deploys.
  const [mode, setMode] = useState<ServerMode | null>(null);
  const [lfsStatus, setLfsStatus] = useState<LfsStatus | null>(null);

  // Open the multiplayer socket once per tab as soon as the app
  // shell mounts. The manager auto-reconnects on drop and is a
  // no-op if already connected, so this single call covers every
  // route in the app — including the ones that don't actually need
  // live pose (e.g. `/feed`), because they still benefit from
  // realtime feedback events.
  useEffect(() => {
    ensureConnected();
  }, []);

  // Probe the server mode once. `/api/health` is cheap (no DB / no
  // bundle read of its own), so a single GET on mount is plenty —
  // the mode doesn't change within a running server process.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const health = await apiGet<HealthResponse>('/api/health');
        if (!cancelled && (health.mode === 'live' || health.mode === 'bundle')) {
          setMode(health.mode);
        }
      } catch {
        // Health failing shouldn't block the app shell — worst case
        // the mode badge stays hidden and Sync stays hidden too,
        // both of which are the safe default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll /api/lfs-status while we're in live mode. We tighten to 2 s
  // whenever either piece of state is active (bulk prefetch OR a Git
  // Sync) and back off to 10 s when everything's quiet. Covers
  // cold-start, post-sync, and "user just clicked Git Sync and the
  // 504-proof fire-and-forget handler returned 202" cases without
  // hammering the endpoint in the steady-state.
  useEffect(() => {
    if (mode !== 'live') return undefined;
    let cancelled = false;
    let timeoutId: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const s = await apiGet<LfsStatus>('/api/lfs-status');
        if (cancelled) return;
        setLfsStatus(s);
        const active = s.running || s.sync?.running === true;
        const delay = active ? 2000 : 10_000;
        timeoutId = window.setTimeout(poll, delay);
      } catch {
        if (cancelled) return;
        // Back off hard on error — the endpoint may be transiently
        // unavailable (e.g. server restarting); don't DoS it.
        timeoutId = window.setTimeout(poll, 15_000);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [mode]);

  // Track the running sync via /api/lfs-status.sync so the button
  // stays "Syncing…" for as long as the real work takes, not just
  // the 202-return round-trip. This flips from the local `syncing`
  // flag (controlled by `handleSync`) to the server-reported flag
  // once the first poll lands, so the two are effectively OR'd.
  const syncActive = syncing || lfsStatus?.sync?.running === true;

  // If the user is currently viewing a specific scene (`/level/<path>`),
  // hand that path to the sync endpoint so the post-sync LFS warm-up
  // narrows to THAT scene's asset graph instead of walking every .mat
  // and image in the repo. On a large Unity project the full bulk
  // pass runs for several minutes; a scene-scoped sync typically
  // completes in under 10 s. On the level grid (no scene context) we
  // fall through to the default full-bulk behaviour, which is the
  // right trade-off there — the reviewer might click any tile next.
  function currentScenePath(): string | undefined {
    const match = loc.pathname.match(/\/level\/(.+)$/);
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  async function handleSync() {
    if (syncActive) return;
    setSyncing(true);
    try {
      // The server now runs sync asynchronously and returns 202
      // immediately (true sync can exceed every HTTP proxy's timeout;
      // the old blocking endpoint was showing up as 504 Gateway
      // Time-out). We don't await the whole sync — we just kick it
      // off and let the /api/lfs-status poller above drive the UI.
      const scenePath = currentScenePath();
      await apiPost('/api/sync', scenePath ? { scenePath } : undefined);
      const s = await apiGet<LfsStatus>('/api/lfs-status');
      setLfsStatus(s);
    } catch (err) {
      alert(`Sync failed: ${(err as Error).message}`);
    } finally {
      // Drop the local flag — from here on `syncActive` is driven by
      // `lfsStatus.sync.running`, which stays true until the
      // background sync completes on the server.
      setSyncing(false);
    }
  }

  return (
    <div className="app-shell">
      {/*
        App-wide SVG filter for the Aegisgram logo PNG. The artwork
        ships with a pure-white background baked in (including inside
        the letter counters), which clashes with the app's dark UI.
        The filter below subtracts RGB brightness from alpha:
          newAlpha = 3*alpha - R - G - B
        White (R=G=B=1) maps to alpha 0 (fully transparent) while
        solid colours / black stay visible, and anti-aliased edges
        get partial alpha for clean compositing. Defined once in a
        hidden SVG so any component can reference it as
        `filter: url(#aegisgram-white-to-alpha)`.
      */}
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        style={{ position: 'absolute', pointerEvents: 'none' }}
      >
        <defs>
          <filter id="aegisgram-white-to-alpha" colorInterpolationFilters="sRGB">
            <feColorMatrix
              type="matrix"
              values="1  0  0  0  0
                      0  1  0  0  0
                      0  0  1  0  0
                      -1 -1 -1 3  0"
            />
          </filter>
        </defs>
      </svg>
      <header className="app-header">
        <Link to="/" className="app-brand" aria-label="Aegisgram home">
          <img
            src={publicAsset('/AegisgramLogo.png')}
            alt=""
            className="app-brand-logo"
            draggable={false}
          />
          <span className="app-brand-name">Aegisgram</span>
        </Link>
        {!atHome && (
          <button type="button" onClick={() => nav('/')}>
            {'\u2190'} Back to list
          </button>
        )}
        <div className="spacer" />
        <nav className="app-nav">
          <Link
            to="/"
            className={`app-nav-link${loc.pathname === '/' ? ' active' : ''}`}
          >
            Scenes
          </Link>
          <Link
            to="/feed"
            className={`app-nav-link${loc.pathname.startsWith('/feed') ? ' active' : ''}`}
          >
            Feed
          </Link>
        </nav>
        <NicknameBadge />
        {/*
          Server-mode badge. Surfaces which backend the user is
          actually talking to so an unexpected 501 on Sync / Rebake
          isn't a mystery — a deployed bundle build is a completely
          different server shape than the live-dev box. Hidden while
          the health probe is still in flight to avoid a layout
          flicker.
        */}
        {mode !== null && (
          <span
            className={`server-mode-badge server-mode-${mode}`}
            title={
              mode === 'bundle'
                ? '사전에 bake된 콘텐츠 번들을 읽는 배포 모드. GitLab 싱크는 비활성.'
                : 'GitLab을 직접 참조하는 로컬 개발 모드.'
            }
          >
            <span className="server-mode-dot" aria-hidden="true" />
            {mode === 'bundle' ? 'Bundle' : 'Live'}
          </span>
        )}
        {/*
          Manual Git Sync progress. Separate from the bulk prefetch
          badge below because sync is "git pull + reset + index
          rebuild" (serial, can't be parallelised usefully) while
          prefetch is "download N LFS blobs" (countable). Rendering
          them as two distinct pills keeps the semantics clear.
        */}
        {mode === 'live' && lfsStatus?.sync?.running && (
          <span
            className="lfs-prefetch-badge"
            title={
              '서버에서 Git pull + reset + 에셋 인덱스 재구성을 ' +
              '실행 중입니다. 완료되면 자동으로 재질/텍스처 일괄 ' +
              '다운로드가 이어집니다.'
            }
          >
            <span className="lfs-prefetch-spinner" aria-hidden="true" />
            <span className="lfs-prefetch-text">Syncing…</span>
          </span>
        )}
        {/*
          Bulk LFS prefetch progress. Shown while the server is
          downloading `.mat` + image pointers in the background —
          either right after startup or after a Git Sync click.
          Surfaces the "why are some scenes magenta right now"
          answer directly in the header so the user isn't guessing.
        */}
        {mode === 'live' && lfsStatus?.running && lfsStatus.total > 0 && (
          <span
            className="lfs-prefetch-badge"
            title={
              `백그라운드에서 재질/텍스처를 받고 있어요 — ` +
              `${lfsStatus.filesDone} / ${lfsStatus.total} 파일 완료. ` +
              `이 작업이 끝나기 전에 여는 씬은 일부 표면이 ` +
              `분홍색으로 보일 수 있습니다.`
            }
          >
            <span className="lfs-prefetch-spinner" aria-hidden="true" />
            <span className="lfs-prefetch-text">
              Assets {lfsStatus.filesDone.toLocaleString()} /{' '}
              {lfsStatus.total.toLocaleString()}
            </span>
            <span
              className="lfs-prefetch-bar"
              aria-hidden="true"
              style={{
                width: `${Math.min(
                  100,
                  Math.round((lfsStatus.filesDone / Math.max(1, lfsStatus.total)) * 100),
                )}%`,
              }}
            />
          </span>
        )}
        {/*
          Git Sync only makes sense in live mode — bundle-mode
          servers can't reach GitLab by design and the endpoint
          returns 501. Hide the button rather than let it return a
          confusing error when clicked.
        */}
        {mode === 'live' && (() => {
          // Label + tooltip reflect the scope the server will actually
          // apply. On a scene page we narrow to that scene's assets;
          // elsewhere it's a full-repo sync. Making the scope visible
          // in the button prevents "why is sync running for 5 min?"
          // confusion when the user only cares about one map.
          const scenePath = currentScenePath();
          const sceneName = scenePath?.split('/').pop()?.replace(/\.unity$/, '');
          const title = scenePath
            ? `Git Sync · 이 씬(${sceneName})의 LFS만 받아옵니다`
            : 'Git Sync · 전체 레포를 pull하고 모든 머티리얼/텍스처를 받아옵니다';
          const label = syncActive
            ? 'Syncing…'
            : scenePath
              ? `Git Sync (이 씬)`
              : 'Git Sync';
          return (
            <button
              type="button"
              onClick={handleSync}
              disabled={syncActive}
              title={title}
            >
              {label}
            </button>
          );
        })()}
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
