import { ExternalLink, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Navigate } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { useDocumentTitle, usePolling } from '../../lib/hooks';
import { BrowserBroadcast } from './BrowserBroadcast';
import { IngestPanel } from './IngestPanel';
import { RecentBroadcasts } from './RecentBroadcasts';
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

function Dashboard() {
  const { markSignedOut } = useAuth();
  const poll = usePolling((signal) => api.dashboard(signal), POLL_MS);

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

      <StatusPanel live={d.live} channel={d.channel} />

      <div className="dash__cols">
        <StreamInfoForm
          channel={d.channel}
          isLive={d.live !== null}
          onSaved={(channel) => poll.mutate((prev) => (prev ? { ...prev, channel } : prev))}
        />
        <IngestPanel ingest={d.ingest} streamKey={d.streamKey} onKeyReset={poll.refresh} />
      </div>

      <BrowserBroadcast whip={d.ingest.whip} live={d.live} />

      <RecentBroadcasts recent={d.recent} />
    </div>
  );
}
