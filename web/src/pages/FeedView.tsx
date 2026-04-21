import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { FeedbackReactions } from '../lib/FeedbackReactions';
import {
  fetchAllFeedbacks,
  removeFeedback,
  type Feedback,
} from '../lib/feedbackStore';
import { subscribeFeedbackEvents } from '../lib/multiplayer';

/**
 * Global social feed — a single-column, newest-first timeline of
 * every feedback the team has posted across every scene. The
 * purpose is exactly what the user asked for: "어떤 맵에서 어떤
 * 피드가 올라왔는지 종합적으로 보는 곳". So the focus of each card
 * is (1) the scene it belongs to, (2) the thumbnail that captured
 * the moment, and (3) the body text. Anchor coordinates / author
 * pose are lower-priority metadata.
 *
 * Data flow:
 *   - On mount, GET /api/feedbacks/all (limit 200) → full timeline.
 *   - Every 15 s while mounted, re-fetch so other team members'
 *     posts appear without requiring a manual refresh. Same cadence
 *     as FeedbackPins' scene-local poll, for consistency.
 *   - Delete button on each card fires removeFeedback() which hits
 *     the server; the page re-fetches the list on success.
 *
 * We deliberately do NOT merge this view into the per-scene
 * FeedbackPanel: the two answer different questions. The side panel
 * is "what feedback is attached to THIS scene". The feed is "what
 * is everyone talking about, everywhere". Keeping them separate
 * lets each render optimally for its task.
 */
/** Which bucket of statuses the feed should show. 'open' is the
 *  default landing filter — reviewers arrive at the feed to answer
 *  "what do I still need to look at", and resolved items are noise
 *  for that loop until you explicitly want to audit them. */
type FeedStatusFilter = 'all' | 'open' | 'resolved';

export default function FeedView() {
  const [feedbacks, setFeedbacks] = useState<Feedback[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<FeedStatusFilter>('open');

  const refresh = useCallback(async () => {
    try {
      const list = await fetchAllFeedbacks(200);
      setFeedbacks(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Poll while the page is open — the feed is meant to feel live.
    // 15 s matches the scene-scoped pin / panel pollers; tightening
    // it would mostly mean hitting localhost faster for no benefit.
    const handle = setInterval(() => {
      void refresh();
    }, 15000);
    // Realtime bridge: apply WS-pushed mutations to the local list
    // in place so likes / comments / new pins reflect immediately
    // instead of waiting for the next 15 s tick. Covers all three
    // event kinds — added (prepend), updated (replace), removed
    // (filter out).
    const unsubWs = subscribeFeedbackEvents((ev) => {
      setFeedbacks((prev) => {
        if (prev === null) return prev;
        if (ev.type === 'added') {
          const without = prev.filter((x) => x.id !== ev.feedback.id);
          return [ev.feedback, ...without].sort((a, b) => b.createdAt - a.createdAt);
        }
        if (ev.type === 'updated') {
          return prev.map((x) => (x.id === ev.feedback.id ? ev.feedback : x));
        }
        return prev.filter((x) => x.id !== ev.id);
      });
    });
    // Per-card live state (likes / comments, both our own optimistic
    // mutations and remote users' actions) flows through the shared
    // feedback cache: `fetchAllFeedbacks` seeds it, and the embedded
    // `<FeedbackReactions>` reads live from there. We DON'T need to
    // re-sync this list on every like event — ordering is stable
    // (createdAt-sorted) and only add / remove mutate it, both of
    // which are covered by `subscribeFeedbackEvents` above.
    return () => {
      clearInterval(handle);
      unsubWs();
    };
  }, [refresh]);

  // Apply the status filter BEFORE day-grouping so empty days that
  // fall out of the filter disappear entirely (vs. rendering as a
  // heading with no cards). Counts shown on the filter chips always
  // reflect the full list, not the filtered one — that's how the
  // user decides which chip to click.
  const counts = useMemo(() => {
    const all = feedbacks ?? [];
    const resolvedN = all.filter((fb) => fb.status === 'resolved').length;
    return {
      all: all.length,
      open: all.length - resolvedN,
      resolved: resolvedN,
    };
  }, [feedbacks]);

  const filteredFeedbacks = useMemo(() => {
    const all = feedbacks ?? [];
    if (statusFilter === 'all') return all;
    if (statusFilter === 'resolved') {
      return all.filter((fb) => fb.status === 'resolved');
    }
    return all.filter((fb) => fb.status !== 'resolved');
  }, [feedbacks, statusFilter]);

  const grouped = useMemo(() => groupByDay(filteredFeedbacks), [filteredFeedbacks]);

  if (error) {
    return (
      <div className="status-banner">
        Failed to load feed: {error}
        <button
          type="button"
          onClick={() => void refresh()}
          style={{ marginLeft: 12 }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (feedbacks === null) {
    return <div className="status-banner">Loading feed...</div>;
  }

  if (feedbacks.length === 0) {
    return (
      <div className="feed-empty">
        <h2>아직 피드백이 없어요</h2>
        <p>
          씬을 열고 Play 모드에 들어가 조준점을 두고 Enter를 누르면
          첫 피드백을 남길 수 있습니다.
        </p>
        <Link to="/" className="feed-empty-cta">
          씬 목록으로 가기
        </Link>
      </div>
    );
  }

  return (
    <div className="feed-view">
      <div className="feed-view-head">
        {/*
          Visual branding replaces the plain "Feed" text — the logo
          already reads as the Aegisgram social wordmark, so a
          duplicate heading would add noise. `alt="Aegisgram Feed"`
          keeps screen readers informed that this region is the feed.
          The PNG has a baked-in white background; the shared SVG
          filter in App.tsx turns white into alpha so it composites
          cleanly onto the dark page.
        */}
        <img
          src="/AegisgramLogo.png"
          alt="Aegisgram Feed"
          className="feed-view-logo"
          draggable={false}
        />
        <div className="muted feed-view-meta">
          최근 {feedbacks.length}건의 피드백 · 15초마다 자동 갱신
        </div>
        {/*
          Status filter chips. Default lands on "확인중" (open-only)
          because the feed's primary loop is "what still needs
          attention" — opening the page should surface unresolved
          items first. "전체" / "확인됨" let the user sweep or audit
          when they need to.
        */}
        <div className="feed-view-filters" role="tablist" aria-label="상태 필터">
          <FeedFilterChip
            label="확인중"
            value="open"
            count={counts.open}
            active={statusFilter === 'open'}
            onClick={() => setStatusFilter('open')}
          />
          <FeedFilterChip
            label="확인됨"
            value="resolved"
            count={counts.resolved}
            active={statusFilter === 'resolved'}
            onClick={() => setStatusFilter('resolved')}
          />
          <FeedFilterChip
            label="전체"
            value="all"
            count={counts.all}
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          />
        </div>
      </div>
      {filteredFeedbacks.length === 0 && (
        <div className="feed-empty-filter muted">
          {statusFilter === 'open' && '확인 대기 중인 피드백이 없어요. 모두 확인됐습니다!'}
          {statusFilter === 'resolved' && '아직 확인된 피드백이 없어요.'}
        </div>
      )}
      {grouped.map((group) => (
        <section key={group.key} className="feed-day">
          <div className="feed-day-heading">
            <span className="feed-day-label">{group.label}</span>
            <span className="feed-day-count muted">{group.items.length}건</span>
          </div>
          <div className="feed-day-items">
            {group.items.map((fb) => (
              <FeedCard
                key={fb.id}
                feedback={fb}
                onDelete={async () => {
                  await removeFeedback(fb.scenePath, fb.id);
                  void refresh();
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FeedFilterChip({
  label,
  value,
  count,
  active,
  onClick,
}: {
  label: string;
  value: FeedStatusFilter;
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
      className={`feed-filter-chip${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      <span className="feed-filter-label">{label}</span>
      <span className="feed-filter-count">{count}</span>
    </button>
  );
}

function FeedCard({
  feedback,
  onDelete,
}: {
  feedback: Feedback;
  onDelete: () => void | Promise<void>;
}) {
  const sceneLabel = sceneLabelFromPath(feedback.scenePath);
  const sceneHref = `/level/${feedback.scenePath.split('/').map(encodeURIComponent).join('/')}`;
  const resolved = feedback.status === 'resolved';
  return (
    <article className={`feed-card${resolved ? ' is-resolved' : ''}`}>
      <header className="feed-card-head">
        <div className="feed-card-scene">
          <Link to={sceneHref} className="feed-card-scene-link" title={feedback.scenePath}>
            <span className="feed-card-scene-name">{sceneLabel.name}</span>
            {sceneLabel.folder && (
              <span className="feed-card-scene-folder muted">{sceneLabel.folder}</span>
            )}
          </Link>
        </div>
        <span
          className={`feedback-status-badge${resolved ? ' is-resolved' : ' is-open'}`}
          title={
            resolved && feedback.resolvedAt !== null
              ? `${feedback.resolvedBy || '누군가'}님이 ${formatRelativeKo(feedback.resolvedAt)} 확인`
              : '확인 대기 중'
          }
        >
          <span aria-hidden="true">{resolved ? '✓' : '●'}</span>
          {resolved ? '확인됨' : '확인중'}
        </span>
        <div className="feed-card-time" title={new Date(feedback.createdAt).toLocaleString('ko-KR')}>
          {formatRelativeKo(feedback.createdAt)}
        </div>
      </header>
      <Link to={sceneHref} className="feed-card-thumb-link" aria-label="해당 씬으로 이동">
        <img className="feed-card-thumb" src={feedback.thumbnail} alt="피드백 당시 화면" />
      </Link>
      <div className="feed-card-body">
        <p className="feed-card-text">{feedback.text || <em className="muted">(내용 없음)</em>}</p>
        <div className="feed-card-foot">
          <span className="feed-card-anchor" title="월드 좌표 (three.js RH, Y-up)">
            @ ({feedback.anchor.map((v) => v.toFixed(1)).join(', ')})
          </span>
          <div className="feed-card-actions">
            <Link to={sceneHref} className="hud-toggle">
              씬 열기
            </Link>
            <button
              type="button"
              className="feed-card-delete"
              onClick={() => void onDelete()}
              title="삭제"
            >
              삭제
            </button>
          </div>
        </div>
        <FeedbackReactions feedback={feedback} variant="feed" />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

interface DayGroup {
  key: string;
  label: string;
  items: Feedback[];
}

/** Group the feed by calendar day (local time). Gives the feed a
 *  Twitter-like rhythm — "오늘 · 어제 · 3일 전" headings break up the
 *  stream into digestible chunks and let the reviewer scan-read. */
function groupByDay(list: Feedback[]): DayGroup[] {
  const byKey = new Map<string, DayGroup>();
  for (const fb of list) {
    const d = new Date(fb.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: dayLabelKo(d), items: [] };
      byKey.set(key, g);
    }
    g.items.push(fb);
  }
  // The list is already newest-first, so insertion order of the Map
  // mirrors chronological order — Array.from(Map.values()) preserves
  // it.
  return Array.from(byKey.values());
}

function dayLabelKo(d: Date): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfD = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfToday - startOfD) / (24 * 60 * 60 * 1000));
  if (days === 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelativeKo(ts: number): string {
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - ts) / 1000));
  if (diffSec < 10) return '방금';
  if (diffSec < 60) return `${diffSec}초 전`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}일 전`;
  return new Date(ts).toLocaleDateString('ko-KR');
}

/** Split a scene path like `Assets/GameContents/Map/Alps/Alps_01.unity`
 *  into `{ name: 'Alps_01', folder: 'GameContents/Map/Alps' }` so the
 *  card can show the familiar short scene name as the headline and
 *  the enclosing folder as quieter context.
 *
 *  We strip the `Assets/` prefix (every scene has it) and the
 *  `.unity` extension — both are noise at the feed level. */
function sceneLabelFromPath(p: string): { name: string; folder: string } {
  let s = p.replace(/\\/g, '/');
  if (s.toLowerCase().startsWith('assets/')) s = s.slice('assets/'.length);
  s = s.replace(/\.unity$/i, '');
  const idx = s.lastIndexOf('/');
  if (idx < 0) return { name: s, folder: '' };
  return { name: s.slice(idx + 1), folder: s.slice(0, idx) };
}
