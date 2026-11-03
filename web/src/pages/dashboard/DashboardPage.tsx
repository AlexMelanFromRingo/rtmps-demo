import { ExternalLink, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Navigate } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { useDocumentTitle, usePolling } from '../../lib/hooks';
import type { ChannelPrivate } from '../../api/types';
import { BrowserBroadcast } from './BrowserBroadcast';
import { HealthPanel } from './HealthPanel';
import { IngestPanel } from './IngestPanel';
import { OverlayPanel } from './OverlayPanel';
import { ProfilePanel } from './ProfilePanel';
import { RecentBroadcasts } from './RecentBroadcasts';
import { RestreamPanel } from './RestreamPanel';
import { StatusPanel } from './StatusPanel';
import { StreamInfoForm } from './StreamInfoForm';
import './Dashboard.css';

const POLL_MS = 3_000;

export function DashboardPage() {
  useDocumentTitle('Студия');
  const { auth, refresh } = useAuth();

  if (auth.status === 'loading') {
    return (
      <div className="center-state" aria-busy="true">
        <div className="spinner" aria-label="Загрузка" />
      </div>
    );
  }
  if (auth.status === 'anon') return <Navigate to="/login?next=%2Fdashboard" replace />;
  if (auth.status === 'error') {
    return (
      <div className="page">
        <div className="notice notice--error" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div className="notice__body">
            <strong>Не удалось проверить вход</strong>
            <span>{auth.message}</span>
            <div className="notice__actions">
              <button type="button" className="btn btn--sm" onClick={() => void refresh()}>
                <RotateCcw aria-hidden="true" />
                Повторить
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return <Dashboard />;
}

const SECTIONS: { id: string; label: string }[] = [
  { id: 'status', label: 'Эфир' },
  { id: 'health', label: 'Здоровье' },
  { id: 'setup', label: 'Подключение' },
  { id: 'profile', label: 'Профиль' },
  { id: 'overlay', label: 'Оверлей' },
  { id: 'multistream', label: 'Мультистрим' },
  { id: 'browser', label: 'Из браузера' },
  { id: 'history', label: 'История' },
];

function Dashboard() {
  const { markSignedOut, refresh: refreshAuth } = useAuth();
  const poll = usePolling((signal) => api.dashboard(signal), POLL_MS);
  const { mutate } = poll;
  const patchChannel = (patch: Partial<ChannelPrivate>) =>
    mutate((prev) => (prev ? { ...prev, channel: { ...prev.channel, ...patch } } : prev));

  // Arriving with #profile etc.: scroll there once the panels exist.
  const ready = poll.data !== null;
  useEffect(() => {
    if (!ready || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [ready]);

  // Session expired while on the page → back to login.
  useEffect(() => {
    if (poll.error instanceof ApiError && poll.error.status === 401) markSignedOut();
  }, [poll.error, markSignedOut]);

  const d = poll.data;

  if (!d) {
    if (poll.error) {
      return (
        <div className="page">
          <div className="notice notice--error" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div className="notice__body">
              <strong>Студия не загрузилась</strong>
              <span>{errorMessage(poll.error)}</span>
              <div className="notice__actions">
                <button type="button" className="btn btn--sm" onClick={poll.refresh}>
                  <RotateCcw aria-hidden="true" />
                  Повторить
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="page dash" aria-busy="true">
        <div className="skeleton" style={{ height: 36, width: 220 }} />
        <div className="skeleton" style={{ height: 360, marginTop: 24, borderRadius: 12 }} />
      </div>
    );
  }

  return (
    <div className="page dash">
      <div className="dash__head">
        <div>
          <h1 className="h-page">Студия</h1>
          <p className="muted dash__sub">
            Канал <span className="dash__slug">{d.channel.displayName}</span>
          </p>
        </div>
        <Link to={`/${d.channel.slug}`} className="btn btn--outline">
          <ExternalLink aria-hidden="true" />
          Страница канала
        </Link>
      </div>

      {poll.error ? (
        <p className="dash__stale" role="status">
          <TriangleAlert aria-hidden="true" />
          Нет связи с сервером, показываем последние данные. {errorMessage(poll.error)}
        </p>
      ) : null}

      <nav className="dash__nav" aria-label="Разделы студии">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="dash__navlink">
            {s.label}
          </a>
        ))}
      </nav>

      <div id="status" className="dash__anchor">
        <StatusPanel live={d.live} channel={d.channel} />
      </div>

      <HealthPanel isLive={d.live !== null} recent={d.recent} />

      <div className="dash__cols dash__anchor" id="setup">
        <StreamInfoForm channel={d.channel} isLive={d.live !== null} onSaved={(channel) => patchChannel(channel)} />
        <IngestPanel ingest={d.ingest} streamKey={d.streamKey} onKeyReset={poll.refresh} />
      </div>

      <div className="dash__cols dash__cols--even">
        <ProfilePanel
          channel={d.channel}
          onSaved={(channel) => patchChannel(channel)}
          onAvatar={(avatarUrl) => {
            patchChannel({ avatarUrl });
            void refreshAuth(); // header avatar
          }}
        />
        <OverlayPanel overlayUrl={d.channel.overlayUrl} onReset={(overlayUrl) => patchChannel({ overlayUrl })} />
      </div>

      <RestreamPanel statuses={d.live?.stats.restreams ?? []} isLive={d.live !== null} />

      <div id="browser" className="dash__anchor">
        <BrowserBroadcast whip={d.ingest.whip} live={d.live} />
      </div>

      <div id="history" className="dash__anchor">
        <RecentBroadcasts recent={d.recent} />
      </div>
    </div>
  );
}
