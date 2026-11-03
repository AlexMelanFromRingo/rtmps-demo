import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { api, errorMessage } from '../api/client';
import { StreamTile } from '../components/StreamTile';
import { useAuth } from '../lib/auth';
import { formatCount, plural, viewersWord } from '../lib/format';
import { useDocumentTitle, useNow, usePolling } from '../lib/hooks';
import './DirectoryPage.css';

const POLL_MS = 15_000;

export function DirectoryPage() {
  useDocumentTitle('Сейчас в эфире');
  const { auth } = useAuth();
  const poll = usePolling((signal) => api.streams(signal), POLL_MS);
  const now = useNow(30_000);

  const streams = poll.data?.streams ?? null;
  const totalViewers = streams?.reduce((sum, s) => sum + s.live.viewers, 0) ?? 0;
  const ctaTarget = auth.status === 'authed' ? '/dashboard' : '/signup';
  const featured = (streams?.length ?? 0) >= 5;

  return (
    <div className="page directory">
      <div className="directory__head">
        <h1 className="h-page">Сейчас в эфире</h1>
        {streams && streams.length > 0 ? (
          <p className="directory__summary">
            <span className="directory__stat">
              <span className="directory__dot" aria-hidden="true" />
              <span className="num">{formatCount(streams.length)}</span>{' '}
              {plural(streams.length, 'трансляция', 'трансляции', 'трансляций')}
            </span>
            <span className="directory__stat">
              <span className="num">{formatCount(totalViewers)}</span> {viewersWord(totalViewers)}
            </span>
          </p>
        ) : null}
      </div>

      {poll.error && streams ? (
        <p className="directory__stale" role="status">
          <TriangleAlert aria-hidden="true" />
          Не удалось обновить список, показываем последние данные. Повторим через несколько секунд.
        </p>
      ) : null}

      {streams === null && poll.error ? (
        <div className="notice notice--error" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div className="notice__body">
            <strong>Список эфиров не загрузился</strong>
            <span>{errorMessage(poll.error)}</span>
            <div className="notice__actions">
              <button type="button" className="btn btn--sm" onClick={poll.refresh}>
                <RotateCcw aria-hidden="true" />
                Повторить
              </button>
            </div>
          </div>
        </div>
      ) : streams === null ? (
        <div className="directory__grid" aria-busy="true" aria-label="Загружаем эфиры">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="tile-skeleton" aria-hidden="true">
              <div className="skeleton tile-skeleton__screen" />
              <div className="skeleton tile-skeleton__line" />
              <div className="skeleton tile-skeleton__line tile-skeleton__line--short" />
            </div>
          ))}
        </div>
      ) : streams.length === 0 ? (
        <div className="directory__empty">
          <div className="directory__monitors" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2 className="directory__empty-title">Сейчас никто не в эфире</h2>
          <p className="muted">
            Станьте первым: подключите OBS или запустите трансляцию прямо из браузера — с камеры или экрана.
          </p>
          <Link to={ctaTarget} className="btn btn--onair">
            <span className="btn__dot" aria-hidden="true" />
            Начать эфир
          </Link>
        </div>
      ) : (
        <ul className={`directory__grid${featured ? ' directory__grid--featured' : ''}`}>
          {streams.map((s, i) => (
            <li key={s.channel.slug}>
              <StreamTile stream={s} thumbTick={poll.updatedAt ?? 0} now={now} featured={featured && i === 0} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
