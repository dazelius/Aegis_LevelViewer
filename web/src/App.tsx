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

export default function App() {
  const loc = useLocation();
  const nav = useNavigate();
  const atHome = loc.pathname === '/';
  const [syncing, setSyncing] = useState(false);
  // `null` = still probing. Keeping the Sync button hidden until
  // we know the mode avoids a flash-of-useless-button on slow
  // cold boots in bundle deploys.
  const [mode, setMode] = useState<ServerMode | null>(null);

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

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      await apiPost('/api/sync');
      window.location.reload();
    } catch (err) {
      alert(`Sync failed: ${(err as Error).message}`);
    } finally {
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
          Git Sync only makes sense in live mode — bundle-mode
          servers can't reach GitLab by design and the endpoint
          returns 501. Hide the button rather than let it return a
          confusing error when clicked.
        */}
        {mode === 'live' && (
          <button type="button" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Git Sync'}
          </button>
        )}
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
