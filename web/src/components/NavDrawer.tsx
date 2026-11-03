import { Heart, LayoutGrid, MonitorPlay, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { useFollowing } from '../lib/following';
import { FollowedLiveList } from './FollowRail';

/** Small-screen navigation: a modal side sheet with the sections and live follows. */
export function NavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { auth } = useAuth();
  const { enabled, live, entries } = useFollowing();
  const location = useLocation();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  // Any navigation closes the sheet.
  useEffect(() => {
    onClose();
  }, [location.pathname, onClose]);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-label="Меню"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="drawer__body">
        <div className="drawer__head">
          <span className="drawer__title">Меню</span>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Закрыть меню">
            <X aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Разделы" className="drawer__nav">
          <NavLink to="/" end className="drawer__link">
            <MonitorPlay aria-hidden="true" />
            Сейчас в эфире
          </NavLink>
          <NavLink to="/directory" className="drawer__link">
            <LayoutGrid aria-hidden="true" />
            Категории
          </NavLink>
          {auth.status === 'authed' ? (
            <NavLink to="/following" className="drawer__link">
              <Heart aria-hidden="true" />
              Отслеживаемые
            </NavLink>
          ) : null}
        </nav>

        {enabled ? (
          <section className="drawer__section" aria-labelledby="drawer-live-h">
            <h2 className="drawer__subtitle" id="drawer-live-h">
              Отслеживаемые в эфире
            </h2>
            {entries === null ? (
              <p className="rail__note">Загружаем…</p>
            ) : live.length ? (
              <FollowedLiveList entries={live} />
            ) : (
              <p className="rail__note">Сейчас никто не в эфире.</p>
            )}
          </section>
        ) : auth.status === 'anon' ? (
          <div className="drawer__auth">
            <Link to="/login" className="btn btn--outline btn--block">
              Войти
            </Link>
            <Link to="/signup" className="btn btn--onair btn--block">
              <span className="btn__dot" aria-hidden="true" />
              Создать канал
            </Link>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
