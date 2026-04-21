import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';

import {
  addComment,
  listFeedbacks,
  removeFeedbackComment,
  setFeedbackStatus,
  subscribeFeedbacks,
  toggleLike,
  type Feedback,
  type FeedbackComment,
} from './feedbackStore';
import { getNickname, subscribeNickname } from './nickname';

/**
 * Like button + comment thread for a single feedback. Shared between
 * the side panel (edit-mode overlay) and the global feed page so both
 * views have identical social behaviour — one place to maintain, one
 * place for the user to learn.
 *
 * Identity model: the local `nickname` (from `./nickname`) is the
 * author handle. Comments can be deleted by the author who wrote
 * them; everyone else sees a bare "X" disabled or simply no delete
 * affordance. This matches the current "no real auth, trusted LAN"
 * posture used everywhere else in the app.
 *
 * The `variant` prop tweaks layout for the narrow side panel vs the
 * wider feed card, but the same component handles both — their
 * behaviour is identical, only density differs.
 */
export function FeedbackReactions({
  feedback: fallback,
  variant = 'panel',
}: {
  feedback: Feedback;
  variant?: 'panel' | 'feed';
}) {
  const [nickname, setNicknameState] = useState<string>(() => getNickname());
  const [draft, setDraft] = useState('');
  // Comment thread is collapsed by default in the panel so the side
  // overlay stays scannable; on the feed page it's expanded so the
  // reader gets the full conversation without extra clicks.
  const [expanded, setExpanded] = useState(variant === 'feed');
  // Live snapshot from the in-memory store. Needed because the
  // feed page renders a detached `feedbacks` state that only
  // refreshes every 15 s (or on a WS echo). When the user clicks
  // "like" on their own card we want the heart to flip instantly,
  // which means reading from the store cache — the store does the
  // optimistic update synchronously. The `fallback` prop is still
  // used when the cache hasn't been populated yet (e.g. first
  // paint before the initial poll lands).
  const [live, setLive] = useState<Feedback | null>(() =>
    findInCache(fallback.scenePath, fallback.id),
  );

  useEffect(() => {
    const unsub = subscribeNickname((n) => setNicknameState(n));
    return unsub;
  }, []);

  useEffect(() => {
    setLive(findInCache(fallback.scenePath, fallback.id));
    const unsub = subscribeFeedbacks(() => {
      setLive(findInCache(fallback.scenePath, fallback.id));
    });
    return unsub;
  }, [fallback.scenePath, fallback.id]);

  const feedback = live ?? fallback;

  const liked = feedback.likes.includes(nickname);
  const likeCount = feedback.likes.length;
  const commentCount = feedback.comments.length;
  const resolved = feedback.status === 'resolved';

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await addComment(feedback.scenePath, feedback.id, nickname, text);
    // If the user was reading collapsed, jump them open so they
    // can see their own reply land.
    setExpanded(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter to post, Shift-Enter to insert a newline. This matches
    // the chat HUD and the feedback composer — consistent keyboard
    // behaviour across every text input in the app.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onFormSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    void submit();
  };

  return (
    <div
      className={`feedback-reactions feedback-reactions-${variant}${resolved ? ' is-resolved' : ''}`}
    >
      <div className="feedback-reactions-bar">
        <button
          type="button"
          className={`feedback-like${liked ? ' is-liked' : ''}`}
          onClick={() => void toggleLike(feedback.scenePath, feedback.id, nickname)}
          title={
            likeCount === 0
              ? '좋아요'
              : feedback.likes.slice(0, 8).join(', ') +
                (likeCount > 8 ? ` 외 ${likeCount - 8}명` : '')
          }
          aria-pressed={liked}
        >
          <span className="feedback-like-icon" aria-hidden="true">
            {liked ? '♥' : '♡'}
          </span>
          <span className="feedback-like-count">{likeCount}</span>
        </button>
        <button
          type="button"
          className={`feedback-comment-toggle${expanded ? ' is-open' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span aria-hidden="true">💬</span>
          <span className="feedback-comment-count">{commentCount}</span>
        </button>
        {/*
          Review-status toggle. "피드백 확인" flips open → resolved and
          stamps the actor + timestamp; the same button labels itself
          "확인 해제" when already resolved so the action is always
          reversible. We read the nickname from the live store so the
          actor stamp matches whatever the user has set right now —
          not whatever it was when the card first rendered.
        */}
        <button
          type="button"
          className={`feedback-status-toggle${resolved ? ' is-resolved' : ''}`}
          onClick={() =>
            void setFeedbackStatus(
              feedback.scenePath,
              feedback.id,
              resolved ? 'open' : 'resolved',
              nickname,
            )
          }
          title={
            resolved
              ? `${feedback.resolvedBy || '누군가'}님이 확인함 — 다시 열기`
              : '피드백 확인 처리'
          }
          aria-pressed={resolved}
        >
          <span className="feedback-status-icon" aria-hidden="true">
            {resolved ? '✓' : '◻'}
          </span>
          <span className="feedback-status-label">
            {resolved ? '확인됨' : '확인'}
          </span>
        </button>
      </div>
      {resolved && feedback.resolvedAt !== null && (
        <div className="feedback-status-note">
          {feedback.resolvedBy || '누군가'}님이{' '}
          {formatRelativeKo(feedback.resolvedAt)} 확인했어요
        </div>
      )}
      {expanded && (
        <div className="feedback-comment-thread">
          {feedback.comments.length === 0 ? (
            <div className="feedback-comment-empty">아직 덧글이 없어요.</div>
          ) : (
            <ul className="feedback-comment-list">
              {feedback.comments.map((c) => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  canDelete={c.author === nickname}
                  onDelete={() =>
                    void removeFeedbackComment(feedback.scenePath, feedback.id, c.id)
                  }
                />
              ))}
            </ul>
          )}
          <form className="feedback-comment-form" onSubmit={onFormSubmit}>
            <textarea
              className="feedback-comment-input"
              placeholder={`${nickname}(으)로 덧글 달기 · Enter로 전송, Shift+Enter 줄바꿈`}
              rows={variant === 'panel' ? 2 : 2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={500}
            />
            <button
              type="submit"
              className="feedback-comment-submit"
              disabled={!draft.trim()}
            >
              전송
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  canDelete,
  onDelete,
}: {
  comment: FeedbackComment;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <li className="feedback-comment-row">
      <div className="feedback-comment-head">
        <span className="feedback-comment-author">{comment.author}</span>
        <span
          className="feedback-comment-time"
          title={new Date(comment.createdAt).toLocaleString('ko-KR')}
        >
          {formatRelativeKo(comment.createdAt)}
        </span>
        {canDelete && (
          <button
            type="button"
            className="feedback-comment-delete"
            onClick={onDelete}
            title="덧글 삭제"
          >
            ×
          </button>
        )}
      </div>
      <div className="feedback-comment-text">{comment.text}</div>
    </li>
  );
}

/** Look up a feedback in the scene-local cache by id. Returns `null`
 *  if the cache is empty for that scene or the id is missing — the
 *  caller falls back to its prop in that case. */
function findInCache(scenePath: string, id: string): Feedback | null {
  const list = listFeedbacks(scenePath);
  return list.find((x) => x.id === id) ?? null;
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
