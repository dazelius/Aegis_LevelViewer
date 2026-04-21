import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchLevels, warmLevel, type SceneCategory, type SceneListItem } from '../lib/api';
import { fetchAllFeedbacks, type Feedback } from '../lib/feedbackStore';
import { subscribeFeedbackEvents } from '../lib/multiplayer';

/**
 * Scenes landing page — the Aegisgram "Explore" surface. Production
 * scenes render as an Instagram-style thumbnail grid (most recent
 * feedback screenshot of each scene becomes its cover image), so
 * reviewers immediately see which maps the team is actively talking
 * about rather than reading a bare file-path list.
 *
 * Data: /api/levels supplies the authoritative scene set; we enrich
 * each entry with aggregated feedback stats pulled from
 * /api/feedbacks/all in a single parallel fetch. A websocket bridge
 * (subscribeFeedbackEvents) keeps the grid live — new pins posted by
 * other users patch the affected tile's thumbnail + counts without
 * waiting for a page refresh.
 */

const CATEGORY_META: Record<
  SceneCategory,
  { label: string; heading: string; description: string }
> = {
  production: {
    label: 'Production',
    heading: '프로덕션 레벨',
    description: '실서비스로 나가는 맵. 여기 달리는 피드백이 가장 우선순위 높아요.',
  },
  'dev-only': {
    label: 'Dev Only',
    heading: 'Dev 샌드박스',
    description: '아트 검증용 맵. 기본 접어 두었습니다.',
  },
};

/** Per-scene rollup of its feedback activity. `null` thumbnail means
 *  the scene has no feedbacks yet — we render a branded placeholder
 *  in that case. */
interface SceneSummary extends SceneListItem {
  thumbnail: string | null;
  totalFeedbacks: number;
  openFeedbacks: number;
  resolvedFeedbacks: number;
  /** Newest feedback's createdAt — drives "hottest first" sorting. */
  lastActivityAt: number | null;
}

/** Which cohort of scenes to show. Defaults to 'all' (the complete
 *  map set is what reviewers scan first); the 'hot' and 'open' chips
 *  narrow to scenes that have recent feedback activity worth
 *  triaging. */
type SceneFilter = 'all' | 'hot' | 'open';

export default function LevelList() {
  const [scenes, setScenes] = useState<SceneListItem[] | null>(null);
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SceneFilter>('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Parallel fetch: /api/levels is the authoritative list; the
        // feedback pull seeds thumbnails + activity counts. Either
        // failing independently is survivable — if feedbacks 500 we
        // still render the grid with placeholder thumbnails.
        const [levels, fbs] = await Promise.all([
          fetchLevels(),
          fetchAllFeedbacks(1000).catch(() => [] as Feedback[]),
        ]);
        if (cancelled) return;
        setScenes(levels);
        setFeedbacks(fbs);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply realtime feedback events to the in-memory list so a
  // teammate's freshly-posted pin lights up the corresponding tile
  // without waiting for a remount. The 'added' handler pushes newest
  // first (matches fetchAllFeedbacks' ordering).
  useEffect(() => {
    const unsub = subscribeFeedbackEvents((ev) => {
      setFeedbacks((prev) => {
        if (ev.type === 'added') {
          const without = prev.filter((x) => x.id !== ev.feedback.id);
          return [ev.feedback, ...without];
        }
        if (ev.type === 'updated') {
          return prev.map((x) => (x.id === ev.feedback.id ? ev.feedback : x));
        }
        return prev.filter((x) => x.id !== ev.id);
      });
    });
    return unsub;
  }, []);

  const summaries = useMemo<SceneSummary[]>(() => {
    if (!scenes) return [];
    // Build a scenePath → aggregate map in one pass. feedbacks are
    // already newest-first coming out of the store; we keep the
    // first thumbnail we see per scene.
    const agg = new Map<
      string,
      {
        thumbnail: string | null;
        total: number;
        open: number;
        resolved: number;
        lastAt: number | null;
      }
    >();
    for (const fb of feedbacks) {
      let entry = agg.get(fb.scenePath);
      if (!entry) {
        entry = { thumbnail: null, total: 0, open: 0, resolved: 0, lastAt: null };
        agg.set(fb.scenePath, entry);
      }
      entry.total += 1;
      if (fb.status === 'resolved') entry.resolved += 1;
      else entry.open += 1;
      if (entry.lastAt === null || fb.createdAt > entry.lastAt) {
        entry.lastAt = fb.createdAt;
        // newest thumbnail wins — matches what feed cards show
        entry.thumbnail = fb.thumbnail || entry.thumbnail;
      }
    }
    return scenes.map((s) => {
      const a = agg.get(s.relPath);
      return {
        ...s,
        thumbnail: a?.thumbnail ?? null,
        totalFeedbacks: a?.total ?? 0,
        openFeedbacks: a?.open ?? 0,
        resolvedFeedbacks: a?.resolved ?? 0,
        lastActivityAt: a?.lastAt ?? null,
      } satisfies SceneSummary;
    });
  }, [scenes, feedbacks]);

  const counts = useMemo(() => {
    const all = summaries.length;
    const hot = summaries.filter((s) => s.totalFeedbacks > 0).length;
    const open = summaries.filter((s) => s.openFeedbacks > 0).length;
    return { all, hot, open };
  }, [summaries]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (s: SceneSummary) => {
      if (needle) {
        const hay = `${s.name} ${s.relPath}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (filter === 'hot') return s.totalFeedbacks > 0;
      if (filter === 'open') return s.openFeedbacks > 0;
      return true;
    };
    return summaries.filter(matches);
  }, [summaries, query, filter]);

  const sorted = useMemo(() => {
    // Hot-first ordering: scenes with newer feedback activity float
    // up regardless of alphabetical order. Scenes with no activity
    // fall to the bottom and sort by name so the list is stable.
    const copy = filtered.slice();
    copy.sort((a, b) => {
      const la = a.lastActivityAt ?? -Infinity;
      const lb = b.lastActivityAt ?? -Infinity;
      if (la !== lb) return lb - la;
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [filtered]);

  const grouped = useMemo(() => {
    const out: Record<SceneCategory, SceneSummary[]> = {
      production: [],
      'dev-only': [],
    };
    for (const s of sorted) out[s.category].push(s);
    return out;
  }, [sorted]);

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

  const prodList = grouped.production;
  const devList = grouped['dev-only'];
  const hasProd = prodList.length > 0;
  const hasDev = devList.length > 0;

  return (
    <div className="scenes-page">
      <header className="scenes-head">
        <div className="scenes-head-row">
          <div className="scenes-title-block">
            <h2 className="scenes-title">Explore</h2>
            <p className="scenes-subtitle">
              {scenes.length}개 씬 · 피드백 활동이 있는 씬이 먼저 떠요
            </p>
          </div>
          <div className="scenes-search-wrap">
            <span className="scenes-search-icon" aria-hidden="true">
              ⌕
            </span>
            <input
              className="scenes-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="씬 이름 또는 경로 검색"
              aria-label="씬 검색"
            />
            {query && (
              <button
                type="button"
                className="scenes-search-clear"
                onClick={() => setQuery('')}
                aria-label="검색어 지우기"
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="scenes-filters" role="tablist" aria-label="씬 필터">
          <SceneFilterChip
            label="전체"
            value="all"
            count={counts.all}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <SceneFilterChip
            label="피드백 있음"
            value="hot"
            count={counts.hot}
            active={filter === 'hot'}
            onClick={() => setFilter('hot')}
          />
          <SceneFilterChip
            label="확인중 남음"
            value="open"
            count={counts.open}
            active={filter === 'open'}
            onClick={() => setFilter('open')}
          />
        </div>
      </header>

      {hasProd ? (
        <section className="scene-section scene-section-production">
          <div className="scene-section-head">
            <h3 className="scene-section-heading">
              {CATEGORY_META.production.heading}
              <span className="scene-section-count">{prodList.length}</span>
            </h3>
            <p className="scene-section-desc">{CATEGORY_META.production.description}</p>
          </div>
          <div className="scene-grid">
            {prodList.map((s) => (
              <SceneTile key={s.relPath} scene={s} />
            ))}
          </div>
        </section>
      ) : (
        <div className="scenes-empty-filter">조건에 맞는 프로덕션 씬이 없어요.</div>
      )}

      {hasDev && (
        <details className="scene-section scene-section-dev">
          <summary className="scene-section-head">
            <h3 className="scene-section-heading">
              {CATEGORY_META['dev-only'].heading}
              <span className="scene-section-count">{devList.length}</span>
            </h3>
            <p className="scene-section-desc">{CATEGORY_META['dev-only'].description}</p>
          </summary>
          <div className="scene-grid">
            {devList.map((s) => (
              <SceneTile key={s.relPath} scene={s} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function SceneFilterChip({
  label,
  value,
  count,
  active,
  onClick,
}: {
  label: string;
  value: SceneFilter;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-filter={value}
      className={`scene-filter-chip${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      <span className="scene-filter-label">{label}</span>
      <span className="scene-filter-count">{count}</span>
    </button>
  );
}

function SceneTile({ scene }: { scene: SceneSummary }) {
  const href = `/level/${scene.relPath.split('/').map(encodeURIComponent).join('/')}`;
  const folder = sceneFolder(scene.relPath);
  // Fire the warm-up hint the moment the user might be about to open
  // this scene. We listen on both pointer-enter (mouse) and focus
  // (keyboard navigation) so either interaction triggers the same
  // background LFS fetch. The server dedupes concurrent hovers.
  const warm = () => warmLevel(scene.relPath);
  return (
    <Link
      to={href}
      className="scene-tile"
      title={scene.relPath}
      onPointerEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
    >
      <div className="scene-tile-thumb-wrap">
        {scene.thumbnail ? (
          <img
            className="scene-tile-thumb"
            src={scene.thumbnail}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : (
          <ScenePlaceholder name={scene.name} category={scene.category} />
        )}
        {scene.openFeedbacks > 0 && (
          <span
            className="scene-tile-pulse"
            title={`확인 대기 중 ${scene.openFeedbacks}건`}
            aria-label={`확인 대기 중 ${scene.openFeedbacks}건`}
          >
            ●
          </span>
        )}
        <div className="scene-tile-overlay">
          <div className="scene-tile-name-line">
            <span className="scene-tile-name">{scene.name}</span>
            {scene.category === 'dev-only' && (
              <span className="scene-tile-kind">DEV</span>
            )}
          </div>
          {folder && <span className="scene-tile-folder">{folder}</span>}
        </div>
      </div>
      <div className="scene-tile-foot">
        {scene.totalFeedbacks === 0 ? (
          <span className="scene-tile-chip scene-tile-chip-empty">피드백 없음</span>
        ) : (
          <>
            {scene.openFeedbacks > 0 && (
              <span className="scene-tile-chip scene-tile-chip-open">
                확인중 {scene.openFeedbacks}
              </span>
            )}
            {scene.resolvedFeedbacks > 0 && (
              <span className="scene-tile-chip scene-tile-chip-resolved">
                확인됨 {scene.resolvedFeedbacks}
              </span>
            )}
            {scene.lastActivityAt !== null && (
              <span className="scene-tile-time">{formatRelativeKo(scene.lastActivityAt)}</span>
            )}
          </>
        )}
      </div>
    </Link>
  );
}

function ScenePlaceholder({
  name,
  category,
}: {
  name: string;
  category: SceneCategory;
}) {
  // Two initials from the scene name — e.g. "Alps_01" → "A0",
  // "Mirama Factory" → "MF". Falls back to "•" for empty strings so
  // the placeholder never renders a blank gradient.
  const initials = useMemo(() => deriveInitials(name), [name]);
  return (
    <div
      className={`scene-tile-placeholder scene-tile-placeholder-${category}`}
      aria-hidden="true"
    >
      <span className="scene-tile-initials">{initials}</span>
    </div>
  );
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function sceneFolder(relPath: string): string {
  let s = relPath.replace(/\\/g, '/');
  if (s.toLowerCase().startsWith('assets/')) s = s.slice('assets/'.length);
  s = s.replace(/\.unity$/i, '');
  const idx = s.lastIndexOf('/');
  return idx < 0 ? '' : s.slice(0, idx);
}

function deriveInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '•';
  const tokens = trimmed.split(/[\s_\-.]+/).filter(Boolean);
  if (tokens.length === 0) return trimmed.slice(0, 2).toUpperCase();
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return (tokens[0][0] + tokens[1][0]).toUpperCase();
}

function formatRelativeKo(ts: number): string {
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - ts) / 1000));
  if (diffSec < 60) return '방금';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}일 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}
