import { ArrowLeft, LayoutGrid, Search, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, errorMessage, isAbortError } from '../../api/client';
import type { Category, ChannelWithLive, SearchResponse } from '../../api/types';
import { formatCount, plural, viewersLabel } from '../../lib/format';
import { useDebouncedValue } from '../../lib/hooks';
import { Avatar } from '../Avatar';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;
const MAX_CHANNELS = 6;
const MAX_CATEGORIES = 4;

type Option =
  | { kind: 'channel'; entry: ChannelWithLive; href: string }
  | { kind: 'category'; category: Category; href: string }
  | { kind: 'all'; href: string };

type Result = { q: string; data: SearchResponse | null; error: unknown };

export function searchHref(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}

export function categoryHref(name: string): string {
  return `/directory/${encodeURIComponent(name)}`;
}

/**
 * Header search: an ARIA 1.2 combobox with a grouped listbox.
 * On small screens it collapses to an icon that expands over the header.
 */
export function HeaderSearch({ onExpandedChange }: { onExpandedChange: (expanded: boolean) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const ids = { input: useId(), list: useId(), channels: useId(), categories: useId() };
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const [q, setQ] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);

  const term = q.trim();
  const debounced = useDebouncedValue(term, DEBOUNCE_MS);

  useEffect(() => {
    if (debounced.length < MIN_CHARS) {
      setResult(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    api.search(debounced, ctrl.signal).then(
      (data) => {
        setResult({ q: debounced, data, error: null });
        setLoading(false);
      },
      (error: unknown) => {
        if (isAbortError(error)) return;
        setResult({ q: debounced, data: null, error });
        setLoading(false);
      },
    );
    return () => ctrl.abort();
  }, [debounced]);

  useEffect(() => setActive(-1), [result]);

  // Navigating anywhere closes the dropdown (and the expanded mobile search).
  useEffect(() => {
    setOpen(false);
    setExpanded(false);
    if (location.pathname !== '/search') setQ('');
  }, [location.pathname, location.search]);

  useEffect(() => onExpandedChange(expanded), [expanded, onExpandedChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const data = result?.data ?? null;
  const channels = data?.channels.slice(0, MAX_CHANNELS) ?? [];
  const categories = data?.categories.slice(0, MAX_CATEGORIES) ?? [];
  const options: Option[] = [
    ...channels.map((entry): Option => ({ kind: 'channel', entry, href: `/${entry.channel.slug}` })),
    ...categories.map((category): Option => ({ kind: 'category', category, href: categoryHref(category.name) })),
  ];
  if (term.length >= MIN_CHARS) options.push({ kind: 'all', href: searchHref(term) });

  const showList = open && term.length >= MIN_CHARS;
  const settled = result !== null && result.q === term && !loading;
  const empty = settled && data !== null && channels.length === 0 && categories.length === 0;
  const optId = (i: number) => `${ids.list}-o${i}`;

  const go = (href: string) => {
    setOpen(false);
    inputRef.current?.blur();
    void navigate(href);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        if (n) setActive((a) => (a + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        if (n) setActive((a) => (a <= 0 ? n - 1 : a - 1));
        break;
      case 'Enter': {
        const opt = showList && active >= 0 ? options[active] : undefined;
        if (opt) {
          e.preventDefault();
          go(opt.href);
        }
        break; // otherwise the form submits → full results page
      }
      case 'Escape':
        if (open && term) {
          e.preventDefault();
          setOpen(false);
          setActive(-1);
        } else if (q) {
          e.preventDefault();
          setQ('');
        } else if (expanded) {
          e.preventDefault();
          collapse();
        }
        break;
      default:
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (term.length >= MIN_CHARS) go(searchHref(term));
  };

  const expand = () => {
    setExpanded(true);
    // The input becomes visible on the next frame.
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const collapse = () => {
    setExpanded(false);
    setOpen(false);
    window.requestAnimationFrame(() => toggleRef.current?.focus());
  };

  let status = '';
  if (term.length > 0 && term.length < MIN_CHARS) status = 'Введите хотя бы 2 символа';
  else if (empty) status = 'Ничего не найдено';
  else if (settled && data)
    status = `Найдено: ${channels.length} ${plural(channels.length, 'канал', 'канала', 'каналов')}, ${categories.length} ${plural(categories.length, 'категория', 'категории', 'категорий')}`;

  const renderOption = (opt: Option, i: number) => {
    const common = {
      id: optId(i),
      role: 'option' as const,
      'aria-selected': active === i,
      className: `hsearch__opt${opt.kind === 'all' ? ' hsearch__opt--all' : ''}`,
      onMouseDown: (e: ReactMouseEvent) => e.preventDefault(),
      onMouseMove: () => setActive(i),
      onClick: () => go(opt.href),
    };
    if (opt.kind === 'channel') {
      const { channel, live } = opt.entry;
      return (
        <div key={opt.href} {...common}>
          <Avatar channel={channel} size={32} live={live !== null} />
          <span className="hsearch__text">
            <span className="hsearch__name">{channel.displayName}</span>
            <span className="hsearch__sub">
              {live ? (
                <>
                  <span className="live-dot" aria-hidden="true" />
                  <span className="num">{viewersLabel(live.viewers)}</span>
                  {channel.title ? <span className="hsearch__title">{channel.title}</span> : null}
                </>
              ) : (
                'не в эфире'
              )}
            </span>
          </span>
        </div>
      );
    }
    if (opt.kind === 'category') {
      const c = opt.category;
      return (
        <div key={opt.href} {...common}>
          <span className="hsearch__icon" aria-hidden="true">
            <LayoutGrid />
          </span>
          <span className="hsearch__text">
            <span className="hsearch__name">{c.name}</span>
            <span className="hsearch__sub">
              {c.liveCount > 0
                ? `${formatCount(c.liveCount)} ${plural(c.liveCount, 'эфир', 'эфира', 'эфиров')} сейчас`
                : 'сейчас нет эфиров'}
            </span>
          </span>
        </div>
      );
    }
    return (
      <div key="all" {...common}>
        <span className="hsearch__icon" aria-hidden="true">
          <Search />
        </span>
        <span className="hsearch__text">
          <span className="hsearch__name">Все результаты по «{term}»</span>
        </span>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className="hsearch"
      data-expanded={expanded ? 'true' : 'false'}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        className="btn btn--ghost btn--icon hsearch__toggle"
        aria-label="Поиск"
        onClick={expand}
      >
        <Search aria-hidden="true" />
      </button>

      <form className="hsearch__form" role="search" onSubmit={onSubmit}>
        <button type="button" className="btn btn--ghost btn--icon hsearch__back" aria-label="Закрыть поиск" onClick={collapse}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <div className="hsearch__field">
          <Search className="hsearch__glyph" aria-hidden="true" />
          <label htmlFor={ids.input} className="visually-hidden">
            Поиск каналов и категорий
          </label>
          <input
            ref={inputRef}
            id={ids.input}
            className="hsearch__input"
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={ids.list}
            aria-activedescendant={showList && active >= 0 ? optId(active) : undefined}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            placeholder="Каналы и категории"
            maxLength={100}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
          {loading ? <span className="spinner spinner--sm hsearch__busy" aria-hidden="true" /> : null}
          {q && !loading ? (
            <button
              type="button"
              className="hsearch__clear"
              aria-label="Очистить поиск"
              onClick={() => {
                setQ('');
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </form>

      <div className="hsearch__pop" hidden={!showList}>
        {settled && result?.error ? (
          <p className="hsearch__note hsearch__note--error">Поиск не ответил: {errorMessage(result.error)}</p>
        ) : null}
        {empty ? <p className="hsearch__note">Ничего не нашлось по «{term}».</p> : null}
        {!settled && !channels.length && !categories.length ? <p className="hsearch__note">Ищем…</p> : null}
        <div id={ids.list} role="listbox" aria-label="Результаты поиска" className="hsearch__list">
          {channels.length ? (
            <div role="group" aria-labelledby={ids.channels}>
              <div className="hsearch__group" id={ids.channels} role="presentation">
                Каналы
              </div>
              {options.map((o, i) => (o.kind === 'channel' ? renderOption(o, i) : null))}
            </div>
          ) : null}
          {categories.length ? (
            <div role="group" aria-labelledby={ids.categories}>
              <div className="hsearch__group" id={ids.categories} role="presentation">
                Категории
              </div>
              {options.map((o, i) => (o.kind === 'category' ? renderOption(o, i) : null))}
            </div>
          ) : null}
          {options.map((o, i) => (o.kind === 'all' ? renderOption(o, i) : null))}
        </div>
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {open ? status : ''}
      </span>
    </div>
  );
}
