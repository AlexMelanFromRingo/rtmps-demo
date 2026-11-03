import { LogOut, Radio, UserRound } from 'lucide-react';
import { Link, NavLink, Outlet, ScrollRestoration, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import './Layout.css';

export function Layout() {
  return (
    <>
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <Header />
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <ScrollRestoration />
    </>
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
  const { auth, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    // Leave protected pages first so they don't bounce to /login on the auth change.
    await navigate('/');
    await logout();
  };

  return (
    <header className="header">
      <div className="header__inner">
        <Wordmark />
        <nav className="header__nav" aria-label="Основная навигация">
          <NavLink to="/" end className="header__link">
            Каталог
          </NavLink>
        </nav>
        <div className="header__actions">
          {auth.status === 'authed' ? (
            <>
              <NavLink to="/dashboard" className="btn btn--onair header__cta">
                <span className="btn__dot" aria-hidden="true" />
                <span>Студия</span>
              </NavLink>
              <Link
                to={`/${auth.channel.slug}`}
                className="header__user"
                title="Страница вашего канала"
              >
                <UserRound aria-hidden="true" />
                <span className="header__user-name">{auth.user.displayName}</span>
              </Link>
              <button
                type="button"
                className="btn btn--ghost btn--icon"
                onClick={() => void onLogout()}
                aria-label="Выйти"
                title="Выйти"
              >
                <LogOut aria-hidden="true" />
              </button>
            </>
          ) : auth.status === 'loading' ? (
            <span className="header__placeholder" aria-hidden="true" />
          ) : (
            <>
              <NavLink to="/login" className="btn btn--ghost">
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
  );
}
