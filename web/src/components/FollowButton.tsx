import { Heart } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, errorMessage } from '../api/client';
import type { FollowResponse } from '../api/types';
import { useFollowing } from '../lib/following';

type Props = {
  slug: string;
  displayName: string;
  /** null = anonymous visitor: clicking sends them to sign in. */
  following: boolean | null;
  followers: number;
  onChange: (next: FollowResponse) => void;
  size?: 'md' | 'sm';
};

/** Follow / unfollow toggle with optimistic update. Hidden by the caller on your own channel. */
export function FollowButton({ slug, displayName, following, followers, onChange, size = 'md' }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useFollowing();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    if (following === null) {
      const next = `${location.pathname}${location.search}`;
      await navigate(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (busy) return;
    const want = !following;
    const prev = { following, followers };
    setBusy(true);
    setError(null);
    onChange({ following: want, followers: Math.max(0, followers + (want ? 1 : -1)) });
    try {
      const res = want ? await api.follow(slug) : await api.unfollow(slug);
      onChange(res);
      refresh();
    } catch (err) {
      onChange(prev);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const on = following === true;
  return (
    <div className="follow">
      <button
        type="button"
        className={`btn ${on ? 'btn--outline' : 'btn--primary'}${size === 'sm' ? ' btn--sm' : ''} follow__btn`}
        aria-pressed={following === null ? undefined : on}
        aria-busy={busy || undefined}
        title={on ? `Перестать отслеживать ${displayName}` : undefined}
        onClick={() => void onClick()}
      >
        <Heart aria-hidden="true" className="follow__heart" fill={on ? 'currentColor' : 'none'} />
        {on ? 'Вы отслеживаете' : 'Отслеживать'}
      </button>
      {error ? (
        <p className="field__error follow__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
