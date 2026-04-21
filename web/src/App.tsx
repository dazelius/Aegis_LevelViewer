import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { apiPost } from './lib/api';
import { ensureConnected } from './lib/multiplayer';
import { NicknameBadge } from './lib/NicknameBadge';

export default function App() {
  const loc = useLocation();
  const nav = useNavigate();
  const atHome = loc.pathname === '/';
  const [syncing, setSyncing] = useState(false);

  // Open the multiplayer socket once per tab as soon as the app
  // shell mounts. The manager auto-reconnects on drop and is a
  // no-op if already connected, so this single call covers every
  // route in the app — including the ones that don't actually need
  // live pose (e.g. `/feed`), because they still benefit from
  // realtime feedback events.
  useEffect(() => {
    ensureConnected();
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
            src="/AegisgramLogo.png"
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
        <button type="button" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing...' : 'Git Sync'}
        </button>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
