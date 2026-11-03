import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { api, errorMessage } from '../api/client';
import type { Category } from '../api/types';
import { CategoryTile } from '../components/CategoryTile';
import { EmptyState, ErrorNotice } from '../components/EmptyState';
import { StreamTile } from '../components/StreamTile';
import { formatCount, plural, viewersWord } from '../lib/format';
import { useDocumentTitle, useNow, usePolling } from '../lib/hooks';

const CATS_POLL_MS = 30_000;
const STREAMS_POLL_MS = 15_000;

function CatGridSkeleton() {
  return (
    <ul className="grid grid--cats" aria-busy="true" aria-label="Загружаем категории">
      {Array.from({ length: 10 }, (_, i) => (
        <li key={i} aria-hidden="true">
          <div className="tile-skeleton">
            <div className="skeleton tile-skeleton__screen" />
            <div className="skeleton tile-skeleton__line tile-skeleton__line--short" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function CatGrid({ items, tick }: { items: Category[]; tick: number }) {
  return (
    <ul className="grid grid--cats">
      {items.map((c) => (
        <li key={c.name}>
          <CategoryTile category={c} thumbTick={tick} />
        </li>
      ))}
    </ul>
  );
}

/** /directory — category tiles: live ones first, then popular over the last 30 days. */
export function CategoriesPage() {
  useDocumentTitle('Категории');
  const poll = usePolling((signal) => api.categories(signal), CATS_POLL_MS);
  const cats = poll.data?.categories ?? null;
  const live = cats?.filter((c) => c.liveCount > 0) ?? [];
  const popular = cats?.filter((c) => c.liveCount === 0) ?? [];
  const tick = poll.updatedAt ?? 0;

  return (
    <div className="page browse">
      <div className="browse__head">
        <h1 className="h-page">Категории</h1>
        {cats && live.length ? (
          <p className="directory__summary">
            <span className="directory__stat">
              <span className="directory__dot" aria-hidden="true" />
              <span className="num">{formatCount(live.length)}</span>{' '}
              {plural(live.length, 'категория', 'категории', 'категорий')} в эфире
            </span>
          </p>
        ) : null}
      </div>

      {cats === null && poll.error ? (
        <ErrorNotice title="Категории не загрузились" message={errorMessage(poll.error)} onRetry={poll.refresh} />
      ) : cats === null ? (
        <CatGridSkeleton />
      ) : cats.length === 0 ? (
        <EmptyState
          title="Категорий пока нет"
          action={
            <Link to="/" className="btn btn--outline">
              Открыть каталог эфиров
            </Link>
          }
        >
          <p>Категории появятся, когда стримеры укажут их в студии.</p>
        </EmptyState>
      ) : live.length && popular.length ? (
        <>
          <section className="browse__section" aria-labelledby="cats-live-h">
            <h2 className="h-section browse__section-title" id="cats-live-h">
              Сейчас в эфире
            </h2>
            <CatGrid items={live} tick={tick} />
          </section>
          <section className="browse__section" aria-labelledby="cats-pop-h">
            <h2 className="h-section browse__section-title" id="cats-pop-h">
              Популярные за месяц
            </h2>
            <CatGrid items={popular} tick={tick} />
          </section>
        </>
      ) : (
        <CatGrid items={cats} tick={tick} />
      )}
    </div>
  );
}

/** /directory/:category — live streams in one category. */
export function CategoryPage() {
  const { category: raw = '' } = useParams();
  const category = raw.trim();
  // Remount per category: the poller must not show the previous category's streams.
  return <CategoryStreams key={category.toLowerCase()} category={category} />;
}

function CategoryStreams({ category }: { category: string }) {
  const poll = usePolling((signal) => api.streams(signal, category), STREAMS_POLL_MS);
  const now = useNow(30_000);
  const streams = poll.data?.streams ?? null;
  // Prefer the casing streamers actually use.
  const name = streams?.[0]?.channel.category || category;
  useDocumentTitle(name);
  const viewers = streams?.reduce((sum, s) => sum + s.live.viewers, 0) ?? 0;

  return (
    <div className="page browse">
      <Link to="/directory" className="browse__crumb">
        <ArrowLeft aria-hidden="true" />
        Все категории
      </Link>
      <div className="browse__head">
        <h1 className="h-page browse__title">{name}</h1>
        {streams && streams.length ? (
          <p className="directory__summary">
            <span className="directory__stat">
              <span className="directory__dot" aria-hidden="true" />
              <span className="num">{formatCount(streams.length)}</span>{' '}
              {plural(streams.length, 'трансляция', 'трансляции', 'трансляций')}
            </span>
            <span className="directory__stat">
              <span className="num">{formatCount(viewers)}</span> {viewersWord(viewers)}
            </span>
          </p>
        ) : null}
      </div>

      {poll.error && streams ? (
        <p className="directory__stale" role="status">
          Не удалось обновить список, показываем последние данные.
        </p>
      ) : null}

      {streams === null && poll.error ? (
        <ErrorNotice title="Эфиры не загрузились" message={errorMessage(poll.error)} onRetry={poll.refresh} />
      ) : streams === null ? (
        <ul className="grid" aria-busy="true" aria-label="Загружаем эфиры">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} aria-hidden="true">
              <div className="tile-skeleton">
                <div className="skeleton tile-skeleton__screen" />
                <div className="skeleton tile-skeleton__line" />
                <div className="skeleton tile-skeleton__line tile-skeleton__line--short" />
              </div>
            </li>
          ))}
        </ul>
      ) : streams.length === 0 ? (
        <EmptyState
          title={`В «${name}» сейчас никого нет`}
          action={
            <Link to="/directory" className="btn btn--outline">
              Другие категории
            </Link>
          }
        >
          <p>Загляните позже или выберите другую категорию.</p>
        </EmptyState>
      ) : (
        <ul className="grid">
          {streams.map((s) => (
            <li key={s.channel.slug}>
              <StreamTile stream={s} thumbTick={poll.updatedAt ?? 0} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
