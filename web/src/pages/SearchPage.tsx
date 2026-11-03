import { Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, errorMessage } from '../api/client';
import { CategoryTile } from '../components/CategoryTile';
import { ChannelRow } from '../components/ChannelRow';
import { EmptyState, ErrorNotice } from '../components/EmptyState';
import { useDebouncedValue, useDocumentTitle, useResource } from '../lib/hooks';

const MIN_CHARS = 2;

/** /search?q= — full results: channels (live first) and categories. */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const inputId = useId();
  const [draft, setDraft] = useState(q);
  const debounced = useDebouncedValue(draft.trim(), 250);
  useDocumentTitle(q ? `Поиск: ${q}` : 'Поиск');

  // `dirty`: the viewer typed here since the last outside change; `pushed`: the last q we wrote.
  const dirty = useRef(false);
  const pushed = useRef<string | null>(null);

  // Header search (or back/forward) changed the query: follow it.
  useEffect(() => {
    if (q === pushed.current) return;
    dirty.current = false;
    setDraft(q);
  }, [q]);

  // Typing here updates the URL (replace: no history spam).
  useEffect(() => {
    if (!dirty.current || debounced === q) return;
    pushed.current = debounced;
    setParams(debounced ? { q: debounced } : {}, { replace: true });
  }, [debounced, q, setParams]);

  const enabled = q.length >= MIN_CHARS;
  const res = useResource((signal) => api.search(q, signal), q, enabled);
  const data = enabled ? res.data : null;

  return (
    <div className="page browse search-page">
      <div className="browse__head">
        <h1 className="h-page">Поиск</h1>
      </div>
      <form
        className="search-page__form"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const v = draft.trim();
          pushed.current = v;
          setParams(v ? { q: v } : {}, { replace: true });
        }}
      >
        <label htmlFor={inputId} className="visually-hidden">
          Поиск каналов и категорий
        </label>
        <Search aria-hidden="true" className="search-page__glyph" />
        <input
          id={inputId}
          className="input search-page__input"
          type="search"
          value={draft}
          maxLength={100}
          placeholder="Имя канала, название эфира или категория"
          autoComplete="off"
          enterKeyHint="search"
          onChange={(e) => {
            dirty.current = true;
            setDraft(e.target.value);
          }}
        />
      </form>

      {!enabled ? (
        <p className="muted search-page__hint">Введите хотя бы 2 символа.</p>
      ) : res.error && !data ? (
        <ErrorNotice title="Поиск не ответил" message={errorMessage(res.error)} onRetry={res.reload} />
      ) : !data ? (
        <div className="center-state" aria-busy="true">
          <div className="spinner" aria-label="Ищем" />
        </div>
      ) : data.channels.length === 0 && data.categories.length === 0 ? (
        <EmptyState
          title={`Ничего не нашлось по «${q}»`}
          action={
            <Link to="/directory" className="btn btn--outline">
              Смотреть категории
            </Link>
          }
        >
          <p>Ищем по имени пользователя, отображаемому имени и названию эфира. Проверьте написание.</p>
        </EmptyState>
      ) : (
        <>
          <p className="visually-hidden" role="status">
            Найдено каналов: {data.channels.length}, категорий: {data.categories.length}
          </p>
          {data.channels.length ? (
            <section className="browse__section" aria-labelledby="sr-ch-h">
              <h2 className="h-section browse__section-title" id="sr-ch-h">
                Каналы
              </h2>
              <ul className="crows">
                {data.channels.map((e) => (
                  <ChannelRow key={e.channel.slug} entry={e} />
                ))}
              </ul>
            </section>
          ) : null}
          {data.categories.length ? (
            <section className="browse__section" aria-labelledby="sr-cat-h">
              <h2 className="h-section browse__section-title" id="sr-cat-h">
                Категории
              </h2>
              <ul className="grid grid--cats">
                {data.categories.map((c) => (
                  <li key={c.name}>
                    <CategoryTile category={c} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
