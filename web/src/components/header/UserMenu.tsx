import { ChevronDown, Heart, LogOut, ShieldCheck, SquarePlay, Tv } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ChannelPublic, User } from '../../api/types';
import { useAuth } from '../../lib/auth';
import { Avatar } from '../Avatar';

type Item = { key: string; icon: ReactNode; label: string; to?: string; onSelect?: () => void };

/** Account menu (menu button pattern): channel, studio, follows, security, sign out. */
export function UserMenu({ user, channel }: { user: User; channel: ChannelPublic }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusFirst = useRef<'first' | 'last'>('first');

  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    (focusFirst.current === 'last' ? items?.[items.length - 1] : items?.[0])?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onLogout = async () => {
    // Leave protected pages first so they don't bounce to /login on the auth change.
    await navigate('/');
    await logout();
  };

  const items: Item[] = [
    { key: 'channel', icon: <Tv />, label: 'Мой канал', to: `/${channel.slug}` },
    { key: 'studio', icon: <SquarePlay />, label: 'Студия', to: '/dashboard' },
    { key: 'following', icon: <Heart />, label: 'Отслеживаемые', to: '/following' },
    { key: 'security', icon: <ShieldCheck />, label: 'Безопасность', to: '/settings/security' },
    { key: 'logout', icon: <LogOut />, label: 'Выйти', onSelect: () => void onLogout() },
  ];

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusFirst.current = e.key === 'ArrowUp' ? 'last' : 'first';
      setOpen(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const idx = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      els[(idx + 1) % els.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      els[(idx - 1 + els.length) % els.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      els[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      els[els.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div ref={rootRef} className="umenu">
      <button
        ref={buttonRef}
        type="button"
        className="header__user"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${user.displayName}: меню аккаунта`}
        onClick={() => {
          focusFirst.current = 'first';
          setOpen((v) => !v);
        }}
        onKeyDown={onButtonKey}
      >
        <Avatar channel={channel} size={28} />
        <span className="header__user-name" aria-hidden="true">
          {user.displayName}
        </span>
        <ChevronDown aria-hidden="true" className="header__chev" />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="umenu__list" role="menu" aria-label="Аккаунт" onKeyDown={onMenuKey}>
          <div className="umenu__who" role="presentation">
            <span className="umenu__name">{user.displayName}</span>
            <span className="umenu__login">@{user.username}</span>
          </div>
          {items.map((it) =>
            it.to ? (
              <Link
                key={it.key}
                to={it.to}
                role="menuitem"
                tabIndex={-1}
                className="umenu__item"
                onClick={() => setOpen(false)}
              >
                <span aria-hidden="true">{it.icon}</span>
                {it.label}
              </Link>
            ) : (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="umenu__item umenu__item--sep"
                onClick={() => {
                  setOpen(false);
                  it.onSelect?.();
                }}
              >
                <span aria-hidden="true">{it.icon}</span>
                {it.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
