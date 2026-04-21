import { useCallback, useEffect, useRef, useState } from 'react';

import {
  addFeedback,
  makeFeedbackId,
  type Feedback,
} from './feedbackStore';
import { playModeState } from './playModeState';

/**
 * HTML overlay that lets the player author a short feedback tied to
 * the current aim point + camera pose + a thumbnail of the exact
 * frame on screen at composer-open time.
 *
 * The entire capture happens synchronously BEFORE this component
 * renders — it's driven from `LevelViewer`'s Enter-key handler,
 * which snapshots aim / pose / canvas and passes them in as props.
 * The composer itself is a purely presentational modal: show the
 * thumbnail, take the text, call `addFeedback` on submit.
 *
 * Keyboard:
 *   Esc            cancel
 *   Ctrl+Enter     submit (Enter alone breaks a new line so the
 *                  user can write a paragraph without having to
 *                  reach for a button)
 *
 * We deliberately do NOT re-request pointer lock on close here —
 * the lock lifecycle is LevelViewer's concern (so it can decide
 * whether to drop the user back into Play mode or into edit mode
 * depending on why the composer closed). The composer only owns
 * the text + the "does the submit succeed" decision.
 */
export interface FeedbackCaptureContext {
  scenePath: string;
  anchor: [number, number, number];
  thumbnail: string;
  cameraPose: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    fov: number;
  };
  playerPose: {
    position: [number, number, number];
    yaw: number;
  };
}

export function FeedbackComposer({
  capture,
  onClose,
}: {
  capture: FeedbackCaptureContext;
  onClose: (submitted: Feedback | null) => void;
}) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autofocus the textarea. We run this in a layout effect via the
  // ref callback pattern so the focus lands on the same tick as the
  // modal mount — important because the user's Enter keypress that
  // opened the composer is still being processed by React on the
  // frame this component first renders.
  useEffect(() => {
    const t = textareaRef.current;
    if (!t) return;
    t.focus();
  }, []);

  // Raise the global input-suppression flag so PlayerController
  // freezes the character and stops consuming WASD / Space / Shift
  // while the composer is open. Without this, the user's
  // "awesome wall!" textarea keystrokes also move the avatar — a
  // confusing "why am I sprinting sideways while typing" bug the
  // user reported ("피드백쓸때 키보드를 치면 wasd 같은걸 입력하면
  // 캐릭터 이동으로 전달된다"). We pair it with the focus effect
  // above so the moment the modal can accept text, the game input
  // is already blocked.
  useEffect(() => {
    playModeState.inputSuppressed = true;
    return () => {
      playModeState.inputSuppressed = false;
    };
  }, []);

  const cancel = useCallback(() => {
    onClose(null);
  }, [onClose]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Empty-body feedback is allowed by the data model (pin-only
      // bookmarks), but the most common "tried to submit empty"
      // cause is accidentally hitting Ctrl+Enter with no text. We
      // just cancel in that case so the user doesn't pollute the
      // feed with silent pins.
      onClose(null);
      return;
    }
    const fb: Feedback = {
      id: makeFeedbackId(),
      scenePath: capture.scenePath,
      createdAt: Date.now(),
      text: trimmed,
      anchor: capture.anchor,
      thumbnail: capture.thumbnail,
      cameraPose: capture.cameraPose,
      playerPose: capture.playerPose,
      // New records start with empty social state. The store's
      // upsert preserves existing likes / comments when a record
      // with the same id is replaced, so this default never stomps
      // on accumulated reactions.
      likes: [],
      comments: [],
      // Brand-new feedback always starts in the 'open' review
      // state — that's the whole point of posting one ("I need
      // somebody to look at this"). Transitioning to 'resolved'
      // happens later via the dedicated status button on each card.
      status: 'open',
      resolvedAt: null,
      resolvedBy: '',
    };
    addFeedback(fb);
    onClose(fb);
  }, [text, capture, onClose]);

  // Global Esc handler. Attached to window (not the modal root) so
  // it wins even if focus somehow escapes the composer — we really
  // do want Esc to cancel no matter what.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cancel]);

  return (
    <div className="feedback-composer-backdrop" onClick={cancel}>
      <div
        className="feedback-composer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="피드백 작성"
      >
        <div className="feedback-composer-head">
          <div className="feedback-composer-title">피드백 남기기</div>
          <div className="feedback-composer-meta">
            <span>{new Date().toLocaleString('ko-KR')}</span>
            <span className="feedback-composer-dot">·</span>
            <span title="조준선이 가리킨 월드 좌표">
              anchor ({capture.anchor.map((v) => v.toFixed(2)).join(', ')})
            </span>
          </div>
        </div>
        <div className="feedback-composer-body">
          <img
            className="feedback-composer-thumb"
            src={capture.thumbnail}
            alt="현재 화면 스냅샷"
          />
          <textarea
            ref={textareaRef}
            className="feedback-composer-text"
            placeholder="여기에 피드백을 적어주세요. 예) 이 벽 텍스처가 늘어나 보여요."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter → submit; plain Enter → newline.
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
            rows={5}
          />
        </div>
        <div className="feedback-composer-foot">
          <span className="feedback-composer-hint">
            Ctrl + Enter 로 등록 · Esc 로 취소
          </span>
          <div className="feedback-composer-actions">
            <button type="button" className="hud-toggle" onClick={cancel}>
              취소
            </button>
            <button
              type="button"
              className="hud-toggle on"
              onClick={submit}
              disabled={!text.trim()}
            >
              등록
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
