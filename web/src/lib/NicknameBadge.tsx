import { useEffect, useRef, useState } from 'react';

import { getNickname, setNickname, subscribeNickname } from './nickname';

/**
 * Inline nickname editor for the app header. Shows the current
 * handle as a small badge; clicking swaps it for a text input the
 * user can rename on the fly. The new name takes effect immediately
 * and is echoed to every room the user is in — chat bubbles,
 * remote-avatar labels, and the "X joined" system line all follow.
 *
 * Why not a separate settings modal: nicknames change rarely but
 * visibly (everyone needs to see what you're called). Keeping the
 * control in the header means there's exactly one place to find and
 * change it — no hidden toggle, no "where are my preferences" hunt.
 */
export function NicknameBadge() {
  const [name, setName] = useState<string>(() => getNickname());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => subscribeNickname((next) => setName(next)), []);

  useEffect(() => {
    if (editing) {
      setDraft(name);
      // Focus on next tick so the <input> exists in the DOM first.
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [editing, name]);

  const commit = () => {
    const next = draft.trim();
    if (next) setNickname(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <form
        className="nickname-badge editing"
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
      >
        <span className="nickname-badge-at">@</span>
        <input
          ref={inputRef}
          className="nickname-badge-input"
          value={draft}
          maxLength={24}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      </form>
    );
  }

  return (
    <button
      type="button"
      className="nickname-badge"
      title="내 닉네임 변경"
      onClick={() => setEditing(true)}
    >
      <span className="nickname-badge-at">@</span>
      <span className="nickname-badge-name">{name}</span>
    </button>
  );
}
