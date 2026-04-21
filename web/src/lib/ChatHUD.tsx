import { useCallback, useEffect, useRef, useState } from 'react';

import {
  listChat,
  listPeers,
  sendChat,
  subscribeChat,
  subscribePeers,
  type ChatLine,
  type Peer,
} from './multiplayer';
import { getNickname } from './nickname';
import { playModeState } from './playModeState';

/**
 * Floating chat overlay pinned to the bottom-left of the viewer.
 *
 * Two modes:
 *   - Collapsed: shows a peer count + "T to chat" hint, and the
 *     three most recent chat lines fade in/out like a game HUD
 *     transcript — keeps the user informed without stealing focus.
 *   - Expanded (user focused the input): full log + text field.
 *     While focused we raise the same `inputSuppressed` flag the
 *     feedback composer uses, so typing WASD in the chat doesn't
 *     send the avatar sprinting.
 *
 * The overlay is mounted outside the R3F Canvas (HTML DOM) so
 * standard input events / accessibility just work. It pulls state
 * from the multiplayer singleton via subscribe functions, so
 * connection / disconnection events live-update the peer count
 * without any React context.
 */
export function ChatHUD() {
  const [chat, setChat] = useState<ChatLine[]>(() => listChat());
  const [peers, setPeers] = useState<Peer[]>(() => listPeers());
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const un1 = subscribeChat(() => setChat(listChat()));
    const un2 = subscribePeers(() => setPeers(listPeers()));
    setChat(listChat());
    setPeers(listPeers());
    return () => {
      un1();
      un2();
    };
  }, []);

  // Auto-scroll the log to the bottom whenever it grows. Runs on
  // both collapsed and expanded views so the latest line is always
  // the one showing.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat, expanded]);

  // Global "T" to focus the chat input, matching common shooter
  // conventions. Suppressed while pointer isn't locked (edit mode
  // background) so typing in other UI boxes isn't hijacked, and
  // while another text input already has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 't' && e.key !== 'T') return;
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
      }
      // Only act when pointer is locked — otherwise T is just the
      // letter T in whatever the user is doing.
      if (!document.pointerLockElement) return;
      e.preventDefault();
      openChat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openChat = useCallback(() => {
    setExpanded(true);
    // Release pointer lock so the user can interact with the input.
    if (document.pointerLockElement) document.exitPointerLock();
    // Raise the same input-suppression flag the feedback composer
    // uses so PlayerController stops reading keys while the chat
    // input has focus.
    playModeState.inputSuppressed = true;
    // Focus on the next tick so the input is in the DOM first.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const closeChat = useCallback(() => {
    setExpanded(false);
    setInput('');
    playModeState.inputSuppressed = false;
    inputRef.current?.blur();
  }, []);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) {
      closeChat();
      return;
    }
    sendChat(text);
    setInput('');
    // Stay open for quick replies feels more natural than auto-
    // collapsing after every message — users drop out with Esc.
    inputRef.current?.focus();
  }, [input, closeChat]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeChat();
      }
    },
    [submit, closeChat],
  );

  const recent = chat.slice(-50);
  // "Tail" view when collapsed — the most recent 3 messages so it
  // still feels alive without taking up screen real estate.
  const tail = recent.slice(-3);
  const peerCount = peers.length + 1; // + self

  return (
    <div className={`chat-hud${expanded ? ' expanded' : ''}`}>
      <div className="chat-hud-head">
        <span className="chat-hud-presence" title="현재 이 씬에 접속한 사람 수">
          <span className="chat-hud-presence-dot" />
          {peerCount}명
        </span>
        <span className="muted chat-hud-hint">
          {expanded ? 'Enter 로 전송 · Esc 로 닫기' : 'T 로 채팅 열기'}
        </span>
      </div>
      <div ref={logRef} className="chat-hud-log">
        {(expanded ? recent : tail).length === 0 ? (
          <div className="chat-hud-empty muted">
            {expanded
              ? '아직 대화가 없어요. 첫 메시지를 남겨보세요.'
              : ''}
          </div>
        ) : (
          (expanded ? recent : tail).map((line, idx) => (
            <ChatLineView key={`${line.ts}-${idx}`} line={line} />
          ))
        )}
      </div>
      {expanded && (
        <form
          className="chat-hud-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <span className="chat-hud-me" title="내 닉네임 (헤더에서 변경 가능)">
            {getNickname()}
          </span>
          <input
            ref={inputRef}
            className="chat-hud-input"
            placeholder="메시지를 입력하세요..."
            value={input}
            maxLength={500}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // Collapse on blur so the HUD shrinks back; but only if
              // the user actually clicked elsewhere, not if we
              // blurred programmatically with closeChat (which has
              // already set expanded=false).
              setTimeout(() => {
                if (document.activeElement !== inputRef.current) {
                  playModeState.inputSuppressed = false;
                  setExpanded(false);
                }
              }, 0);
            }}
          />
          <button type="submit" className="chat-hud-send">
            전송
          </button>
        </form>
      )}
      {!expanded && (
        <button
          type="button"
          className="chat-hud-open"
          onClick={openChat}
          title="채팅 열기 (T)"
        >
          채팅
        </button>
      )}
    </div>
  );
}

function ChatLineView({ line }: { line: ChatLine }) {
  const isSystem = line.id === '';
  return (
    <div className={`chat-hud-line${line.self ? ' self' : ''}${isSystem ? ' system' : ''}`}>
      {!isSystem && (
        <span className="chat-hud-who" title={new Date(line.ts).toLocaleTimeString('ko-KR')}>
          {line.nickname || 'Guest'}
        </span>
      )}
      <span className="chat-hud-text">{line.text}</span>
    </div>
  );
}
