import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchLevels, type SceneCategory, type SceneListItem } from '../lib/api';

/** Display metadata for each category — kept next to the component so the
 *  list and the legend stay in sync. */
const CATEGORY_META: Record<SceneCategory, { label: string; heading: string; className: string }> =
  {
    production: {
      label: 'Production',
      heading: 'Production levels',
      className: 'scene-badge scene-badge-production',
    },
    'dev-only': {
      label: 'Dev Only',
      heading: 'Dev Only (art sandbox)',
      className: 'scene-badge scene-badge-dev',
    },
  };

/** Production scenes render first because those are the ones reviewers
 *  are usually looking for; dev-only scenes drop to the bottom. */
const CATEGORY_ORDER: SceneCategory[] = ['production', 'dev-only'];

export default function LevelList() {
  const [scenes, setScenes] = useState<SceneListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchLevels();
        if (!cancelled) setScenes(data);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    const out: Record<SceneCategory, SceneListItem[]> = {
      production: [],
      'dev-only': [],
    };
    if (!scenes) return out;
    for (const s of scenes) out[s.category].push(s);
    return out;
  }, [scenes]);

  if (error) return <div className="status-banner">Failed to load scenes: {error}</div>;
  if (scenes === null) return <div className="status-banner">Loading scenes...</div>;
  if (scenes.length === 0) {
    return (
      <div className="status-banner">
        No .unity scenes found. The git sync might still be running, or the sparse-checkout may not
        include any scenes yet. Try the "Git Sync" button after a moment.
      </div>
    );
  }

  return (
    <div className="level-list">
      <h2>Scenes ({scenes.length})</h2>
      {CATEGORY_ORDER.map((cat) => {
        const list = grouped[cat];
        if (list.length === 0) return null;
        const meta = CATEGORY_META[cat];
        return (
          <section key={cat} className={`scene-section scene-section-${cat}`}>
            <h3 className="scene-section-heading">
              {meta.heading} <span className="muted">({list.length})</span>
            </h3>
            <ul>
              {list.map((s) => (
                <li key={s.relPath}>
                  <Link to={`/level/${s.relPath.split('/').map(encodeURIComponent).join('/')}`}>
                    <span className="scene-name">{s.name}</span>
                  </Link>
                  <span className={meta.className}>{meta.label}</span>
                  <span className="scene-path">{s.relPath}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
