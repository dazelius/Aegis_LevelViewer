import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { apiPost } from './lib/api';

export default function App() {
  const loc = useLocation();
  const nav = useNavigate();
  const atHome = loc.pathname === '/';
  const [syncing, setSyncing] = useState(false);

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
      <header className="app-header">
        <h1>Aegis Level Viewer</h1>
        {!atHome && (
          <button type="button" onClick={() => nav('/')}>
            {'\u2190'} Back to list
          </button>
        )}
        <div className="spacer" />
        <Link to="/">Scenes</Link>
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
