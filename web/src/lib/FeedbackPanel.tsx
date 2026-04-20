import { useEffect, useState } from 'react';

import {
  listFeedbacks,
  removeFeedback,
  subscribeFeedbacks,
  type Feedback,
} from './feedbackStore';

/**
 * Side panel that lists every feedback authored for the current
 * scene, newest-first. Rendered as an HTML overlay on top of the
 * canvas in edit mode — hidden during Play so it doesn't compete
 * with the game view. Each card shows the stored thumbnail, the
 * author text, and the relative creation time ("방금", "5분 전",
 * "3일 전"); a trash button deletes the record.
 *
 * Click handling is intentionally minimal: M1 just lists. Clicking
 * a card to "jump the camera to this view" is an M3/M4 feature and
 * lives with the eventual camera-bridge code.
 */
export function FeedbackPanel({ scenePath }: { scenePath: string }) {
  const [feedbacks, setFeedbacks] = useState<Feedback[]>(() => listFeedbacks(scenePath));
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setFeedbacks(listFeedbacks(scenePath));
    return subscribeFeedbacks(() => {
      setFeedbacks(listFeedbacks(scenePath));
    });
  }, [scenePath]);

  if (feedbacks.length === 0 && collapsed) return null;

  return (
    <div className={`feedback-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="feedback-panel-head">
        <div className="feedback-panel-title">
          피드백 <span className="feedback-panel-count">{feedbacks.length}</span>
        </div>
        <button
          type="button"
          className="feedback-panel-toggle"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? '피드 열기' : '피드 접기'}
        >
          {collapsed ? '▾' : '▴'}
        </button>
      </div>
      {!collapsed && (
        <div className="feedback-panel-body">
          {feedbacks.length === 0 ? (
            <div className="feedback-panel-empty">
              플레이 모드에서 조준 후 Enter를 눌러 피드백을 남길 수 있어요.
            </div>
          ) : (
            feedbacks.map((fb) => (
              <FeedbackCard
                key={fb.id}
                feedback={fb}
                onDelete={() => removeFeedback(scenePath, fb.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FeedbackCard({
  feedback,
  onDelete,
}: {
  feedback: Feedback;
  onDelete: () => void;
}) {
  return (
    <div className="feedback-card">
      <img
        className="feedback-card-thumb"
        src={feedback.thumbnail}
        alt="피드백 당시 화면"
      />
      <div className="feedback-card-body">
        <div className="feedback-card-meta">
          <span className="feedback-card-time" title={new Date(feedback.createdAt).toLocaleString('ko-KR')}>
            {formatRelativeKo(feedback.createdAt)}
          </span>
          <button
            type="button"
            className="feedback-card-delete"
            onClick={onDelete}
            title="삭제"
          >
            ×
          </button>
        </div>
        <div className="feedback-card-text">{feedback.text}</div>
        <div className="feedback-card-anchor" title="월드 좌표 (three.js RH, Y-up)">
          @ ({feedback.anchor.map((v) => v.toFixed(1)).join(', ')})
        </div>
      </div>
    </div>
  );
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
