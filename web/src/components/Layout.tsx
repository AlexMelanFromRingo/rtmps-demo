import { Menu, Radio } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { readPref, writePref } from '../lib/browser';
import { FollowingProvider, useFollowing } from '../lib/following';
import { useMediaQuery } from '../lib/hooks';
import { FollowRail } from './FollowRail';
import { HeaderSearch } from './header/HeaderSearch';
import { UserMenu } from './header/UserMenu';
import { NavDrawer } from './NavDrawer';
import './Layout.css';

/** Work-focused pages get the full width: no follow rail there. */
const NO_RAIL = /^\/(dashboard|settings)(\/|$)/;

export function Layout() {
  return (
    <FollowingProvider>
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <Header />
      <Shell />
      <ScrollRestoration />
    </FollowingProvider>
  );
}

function Shell() {
  const { enabled } = useFollowing();
  const location = useLocation();
  const wide = useMediaQuery('(min-width: 1200px)');
  const [collapsed, setCollapsed] = useState(() => readPref('rail') === 'collapsed');
  const showRail = enabled && wide && !NO_RAIL.test(location.pathname);

  const toggle = () => {
    setCollapsed((c) => {
      writePref('rail', c ? 'open' : 'collapsed');
      return !c;
    });
  };

  return (
    <div className="shell" data-rail={showRail ? (collapsed ? 'collapsed' : 'open') : 'none'}>
      {showRail ? <FollowRail collapsed={collapsed} onToggle={toggle} /> : null}
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label="StreamHub — на главную">
      <span className="wordmark__mark" aria-hidden="true">
        <span className="wordmark__tally" />
      </span>
      <span className="wordmark__text">StreamHub</span>
    </Link>
  );
}

function Header() {
  const { auth } = useAuth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <>
    <header className="header" data-search-open={searchOpen ? 'true' : 'false'}>
      <div className="header__inner">
        <button
          type="button"
          className="btn btn--ghost btn--icon header__menu"
          aria-label="Меню"
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu aria-hidden="true" />
        </button>
        <Wordmark />
        <nav className="header__nav" aria-label="Основная навигация">
          <NavLink to="/" end className="header__link">
            Каталог
          </NavLink>
          <NavLink to="/directory" className="header__link">
            Категории
          </NavLink>
          {auth.status === 'authed' ? (
            <NavLink to="/following" className="header__link">
              Отслеживаемые
            </NavLink>
          ) : null}
        </nav>
        <HeaderSearch onExpandedChange={setSearchOpen} />
        <div className="header__actions">
          {auth.status === 'authed' ? (
            <>
              <NavLink to="/dashboard" className="btn btn--onair header__cta">
                <span className="btn__dot" aria-hidden="true" />
                <span>Студия</span>
              </NavLink>
              <UserMenu user={auth.user} channel={auth.channel} />
            </>
          ) : auth.status === 'loading' ? (
            <span className="header__placeholder" aria-hidden="true" />
          ) : (
            <>
              <NavLink to="/login" className="btn btn--ghost header__login">
                Войти
              </NavLink>
              <NavLink to="/signup" className="btn btn--onair header__cta">
                <Radio aria-hidden="true" />
                <span>Начать эфир</span>
              </NavLink>
            </>
          )}
        </div>
      </div>
    </header>
    {/* Outside the header: its backdrop-filter would otherwise contain fixed descendants. */}
    <NavDrawer open={drawerOpen} onClose={closeDrawer} />
    </>
  );
}
