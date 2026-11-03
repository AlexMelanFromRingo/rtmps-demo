import { useEffect } from 'react';
import { Link, Navigate } from 'react-router';
import { errorMessage } from '../api/client';
import type { StreamCard } from '../api/types';
import { ChannelRow } from '../components/ChannelRow';
import { EmptyState, ErrorNotice } from '../components/EmptyState';
import { StreamTile } from '../components/StreamTile';
import { useAuth } from '../lib/auth';
import { useFollowing } from '../lib/following';
import { useDocumentTitle, useNow } from '../lib/hooks';

/** /following — every followed channel; live ones as monitors first. */
export function FollowingPage() {
  useDocumentTitle('Отслеживаемые');
  const { auth } = useAuth();
  const { entries, error, refresh } = useFollowing();
  const now = useNow(30_000);
  const tick = useNow(15_000);

  // Fresh data when the page opens (the provider otherwise polls once a minute).
  useEffect(() => {
    if (auth.status === 'authed') refresh();
  }, [auth.status, refresh]);

  if (auth.status === 'loading') {
    return (
      <div className="center-state" aria-busy="true">
        <div className="spinner" aria-label="Загрузка" />
      </div>
    );
  }
  if (auth.status !== 'authed') return <Navigate to="/login?next=%2Ffollowing" replace />;

  const live = (entries?.filter((e) => e.live !== null) ?? []) as StreamCard[];
  const offline = entries?.filter((e) => e.live === null) ?? [];

  return (
    <div className="page browse">
      <div className="browse__head">
        <h1 className="h-page">Отслеживаемые</h1>
      </div>
      {entries === null && error ? (
        <ErrorNotice title="Список не загрузился" message={errorMessage(error)} onRetry={refresh} />
      ) : entries === null ? (
        <div className="center-state" aria-busy="true">
          <div className="spinner" aria-label="Загрузка" />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title="Вы пока никого не отслеживаете"
          action={
            <Link to="/" className="btn btn--primary">
              Открыть каталог
            </Link>
          }
        >
          <p>Нажмите «Отслеживать» на странице канала — он появится здесь и в боковой панели, когда выйдет в эфир.</p>
        </EmptyState>
      ) : (
        <>
          <section className="browse__section" aria-labelledby="fl-live-h">
            <h2 className="h-section browse__section-title" id="fl-live-h">
              В эфире
            </h2>
            {live.length ? (
              <ul className="grid">
                {live.map((s) => (
                  <li key={s.channel.slug}>
                    <StreamTile stream={s} thumbTick={tick} now={now} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Сейчас никто из отслеживаемых не в эфире.</p>
            )}
          </section>
          {offline.length ? (
            <section className="browse__section" aria-labelledby="fl-off-h">
              <h2 className="h-section browse__section-title" id="fl-off-h">
                Не в эфире
              </h2>
              <ul className="crows">
                {offline.map((e) => (
                  <ChannelRow key={e.channel.slug} entry={e} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
