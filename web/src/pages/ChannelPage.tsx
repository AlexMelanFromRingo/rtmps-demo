import { CalendarClock, RotateCcw, SquarePlay, TriangleAlert, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage, isAbortError } from '../api/client';
import type { ChannelPublic, ChannelStateEvent, ChannelViewer, LastBroadcast, LiveInfo } from '../api/types';
import { Avatar } from '../components/Avatar';
import { FollowButton } from '../components/FollowButton';
import { categoryHref } from '../components/header/HeaderSearch';
import { MatureGate } from '../components/MatureGate';
import { Player } from '../components/Player';
import { RenditionLadder } from '../components/RenditionLadder';
import { StatusBadge, broadcastState, type BroadcastState } from '../components/StatusBadge';
import { Thumb } from '../components/Thumb';
import { useAuth } from '../lib/auth';
import { getViewerId, hasMatureConsent } from '../lib/browser';
import {
  codecLabel,
  formatCount,
  formatDateTime,
  followersLabel,
  formatDuration,
  formatFps,
  formatRelativeDay,
  formatUptime,
  protocolLabel,
  sinceMs,
  viewersWord,
  withCacheBust,
} from '../lib/format';
import { useDocumentTitle, useDocumentVisible, useLatest, useNow } from '../lib/hooks';
import { ChannelAbout, ChannelVideos } from './ChannelSections';
import { NotFoundPage } from './NotFoundPage';
import './ChannelPage.css';

const SLUG_RE = /^[A-Za-z0-9_]{1,64}$/;
const HEARTBEAT_MS = 20_000;
const INFO_REFRESH_MS = 30_000;
/** The server sends `event: ping` every 15 s; silence longer than this means a dead stream. */
const SSE_SILENCE_MS = 40_000;

type Phase = 'loading' | 'ready' | 'notfound' | 'error';

type ChannelInfo = { channel: ChannelPublic; lastBroadcast: LastBroadcast | null; viewer: ChannelViewer | null };

type Tab = 'live' | 'videos';

/**
 * Channel state = initial GET + Server-Sent Events. SSE `state` events replace `live`;
 * the GET supplies channel info and lastBroadcast and is re-run on transitions.
 */
function useChannel(slug: string) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ChannelInfo | null>(null);
  const [live, setLive] = useState<LiveInfo | null>(null);
  const [sseHealthy, setSseHealthy] = useState(true);
  const gotEventRef = useRef(false);
  const sseHealthyRef = useLatest(sseHealthy);
  const loadedRef = useRef(false);

  /** Resolves false when the request failed (server unreachable, 5xx…). */
  const load = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      try {
        const res = await api.channel(slug, signal);
        setInfo({ channel: res.channel, lastBroadcast: res.lastBroadcast, viewer: res.viewer ?? null });
        // SSE is the source of truth for `live` once it has spoken (and is connected).
        if (!gotEventRef.current || !sseHealthyRef.current) setLive(res.live);
        loadedRef.current = true;
        setPhase('ready');
        setError(null);
        return true;
      } catch (err) {
        if (isAbortError(err)) return true;
        if (err instanceof ApiError && err.status === 404) {
          setPhase('notfound');
        } else if (!loadedRef.current) {
          setPhase('error');
          setError(errorMessage(err));
        }
        return false;
      }
    },
    [slug, sseHealthyRef],
  );

  // Initial load (and on slug change).
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    gotEventRef.current = false;
    loadedRef.current = false;
    setPhase('loading');
    setInfo(null);
    setLive(null);
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, attempt]);

  // Live updates over SSE, with manual reconnect if the browser gives up.
  // `esNonce` forces a fresh connection when we suspect a silently dead stream.
  const enabled = phase !== 'notfound';
  const [esNonce, setEsNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let timer: number | undefined;
    let retries = 0;
    let disposed = false;
    let lastEventAt = Date.now();

    const connect = () => {
      if (disposed) return;
      lastEventAt = Date.now();
      es = new EventSource(api.channelEventsUrl(slug));
      es.addEventListener('open', () => {
        retries = 0;
        lastEventAt = Date.now();
        setSseHealthy(true);
      });
      es.addEventListener('ping', () => {
        lastEventAt = Date.now();
      });
      es.addEventListener('state', (e) => {
        lastEventAt = Date.now();
        try {
          const data = JSON.parse((e as MessageEvent<string>).data) as ChannelStateEvent;
          gotEventRef.current = true;
          setSseHealthy(true);
          setLive(data.live ?? null);
          const channel = data.channel;
          if (channel) setInfo((prev) => (prev ? { ...prev, channel } : prev));
        } catch {
          /* ignore malformed event */
        }
      });
      es.addEventListener('error', () => {
        setSseHealthy(false);
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          const delay = Math.min(1000 * 2 ** retries, 30_000);
          retries += 1;
          timer = window.setTimeout(connect, delay);
        }
      });
    };
    connect();
    // Half-open connections (proxy dropped us silently) never fire 'error':
    // detect them by the missing server pings and reconnect.
    const watchdog = window.setInterval(() => {
      if (!es || es.readyState === EventSource.CLOSED || Date.now() - lastEventAt < SSE_SILENCE_MS) return;
      setSseHealthy(false);
      es.close();
      window.clearTimeout(timer);
      connect();
    }, 10_000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearInterval(watchdog);
      es?.close();
    };
  }, [slug, enabled, esNonce]);

  // Re-fetch channel info on broadcast transitions (title/category/lastBroadcast change).
  const prevBroadcast = useRef<string | null | undefined>(undefined);
  const broadcastId = live?.broadcastId ?? null;
  useEffect(() => {
    if (phase !== 'ready') return;
    if (prevBroadcast.current !== undefined && prevBroadcast.current !== broadcastId) void load();
    prevBroadcast.current = broadcastId;
  }, [broadcastId, phase, load]);

  // Periodic refresh: picks up title edits; doubles as the fallback when SSE is down.
  const visible = useDocumentVisible();
  useEffect(() => {
    if (phase !== 'ready' || !visible) return;
    const id = window.setInterval(() => {
      void load().then((ok) => {
        // If the API is unreachable, assume the event stream is dead too.
        if (!ok) {
          setSseHealthy(false);
          setEsNonce((n) => n + 1);
        }
      });
    }, sseHealthy ? INFO_REFRESH_MS : 10_000);
    return () => window.clearInterval(id);
  }, [phase, visible, sseHealthy, load]);

  return { phase, error, info, setInfo, live, sseHealthy, retry: () => setAttempt((n) => n + 1) };
}

/** Viewer heartbeat: every 20 s while live and the tab is visible, plus right when playback starts. */
function useHeartbeat(slug: string, active: boolean) {
  const visible = useDocumentVisible();
  const lastSent = useRef(0);

  const send = useCallback(() => {
    lastSent.current = Date.now();
    api.heartbeat(slug, getViewerId()).catch(() => {
      /* best effort */
    });
  }, [slug]);

  useEffect(() => {
    if (!active || !visible) return;
    if (Date.now() - lastSent.current >= HEARTBEAT_MS) send();
    const id = window.setInterval(send, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [active, visible, send]);

  return useCallback(() => {
    if (active && Date.now() - lastSent.current > 5_000) send();
  }, [active, send]);
}

const ANNOUNCE: Record<BroadcastState, string> = {
  live: 'Трансляция идёт',
  starting: 'Трансляция начинается',
  reconnecting: 'Стример переподключается',
  offline: 'Канал не в эфире',
};

export function ChannelPage() {
  const { slug = '' } = useParams();
  if (!SLUG_RE.test(slug)) return <NotFoundPage />;
  return <Channel key={slug} slug={slug} />;
}

function Channel({ slug }: { slug: string }) {
  const { phase, error, info, setInfo, live, sseHealthy, retry } = useChannel(slug);
  const { auth } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'videos' ? 'videos' : 'live';
  const [consented, setConsented] = useState(() => hasMatureConsent(slug));
  const stageRef = useRef<HTMLDivElement>(null);
  const tabIds = { base: useId() };
  const state = broadcastState(live);
  const now = useNow(1000, live !== null);
  const onPlaying = useHeartbeat(slug, live !== null);
  // Thumbnail refresh for the "starting" stage.
  const thumbTick = useNow(10_000, state === 'starting' || state === 'reconnecting');

  const channel = info?.channel;
  useDocumentTitle(channel ? `${state === 'live' ? '● ' : ''}${channel.displayName}` : null);

  if (phase === 'notfound') return <NotFoundPage what="channel" />;

  if (phase === 'error') {
    return (
      <div className="page page--narrow">
        <div className="notice notice--error" role="alert">
          <TriangleAlert aria-hidden="true" />
          <div className="notice__body">
            <strong>Канал не загрузился</strong>
            <span>{error}</span>
            <div className="notice__actions">
              <button type="button" className="btn btn--sm" onClick={retry}>
                <RotateCcw aria-hidden="true" />
                Повторить
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'loading' || !channel) {
    return (
      <div className="page page--narrow channel" aria-busy="true">
        <div className="skeleton channel__stage-skeleton" />
        <div className="skeleton" style={{ height: 28, width: '40%', marginTop: 24 }} />
        <div className="skeleton" style={{ height: 18, width: '60%', marginTop: 12 }} />
      </div>
    );
  }

  const thumb = live?.thumbnailUrl ? withCacheBust(live.thumbnailUrl, thumbTick) : null;
  const showPlayer = live !== null && live.playbackUrl !== null;
  const uptime = live ? formatUptime(sinceMs(live.startedAt, now)) : null;
  const own = auth.status === 'authed' && auth.channel.slug.toLowerCase() === channel.slug.toLowerCase();
  const gated = channel.mature && !consented && !own;

  const selectTab = (next: Tab) => {
    setParams(next === 'videos' ? { tab: 'videos' } : {}, { replace: true, preventScrollReset: true });
  };
  const tabId = (t: Tab) => `${tabIds.base}-tab-${t}`;
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next: Tab = e.key === 'Home' ? 'live' : e.key === 'End' ? 'videos' : tab === 'live' ? 'videos' : 'live';
    selectTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <div className="page page--narrow channel" data-state={state}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {ANNOUNCE[state]}
      </p>

      <div className="channel__stage" ref={stageRef} tabIndex={-1}>
        {live && gated ? (
          <MatureGate
            slug={channel.slug}
            displayName={channel.displayName}
            onAccept={() => {
              setConsented(true);
              window.requestAnimationFrame(() => stageRef.current?.querySelector<HTMLElement>('.player')?.focus());
            }}
          />
        ) : showPlayer && live?.playbackUrl ? (
          <Player
            key={live.broadcastId}
            src={live.playbackUrl}
            renditions={live.renditions}
            live={state === 'live'}
            lowLatency={live.latencyMode === 'low'}
            poster={live.thumbnailUrl}
            label={`Трансляция ${channel.displayName}`}
            onPlaying={onPlaying}
            overlay={state === 'reconnecting' ? <ReconnectingNotice /> : undefined}
          />
        ) : live ? (
          <div className="stage stage--starting">
            <Thumb src={thumb} className="stage__thumb" />
            <div className="stage__veil" />
            <div className="stage__msg">
              <div className="spinner" aria-hidden="true" />
              {state === 'reconnecting' ? (
                <>
                  <strong>Стример переподключается…</strong>
                  <span>Ждём сигнал до 30 секунд.</span>
                </>
              ) : (
                <>
                  <strong>Эфир начинается</strong>
                  <span>Готовим видео — обычно это несколько секунд.</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <OfflineStage last={info.lastBroadcast} onVideos={() => selectTab('videos')} />
        )}
      </div>

      {!sseHealthy ? (
        <p className="channel__conn" role="status">
          <WifiOff aria-hidden="true" />
          Потеряна связь с сервером — восстанавливаем. Статус эфира может отставать.
        </p>
      ) : null}

      <div className="channel__bar">
        <div className="channel__who">
          <Avatar channel={channel} size={56} live={state === 'live'} />
          <div className="channel__ident">
            <h1 className="channel__name">{channel.displayName}</h1>
            {channel.title ? <p className="channel__title">{channel.title}</p> : null}
            <div className="channel__tags">
              {channel.category ? (
                <Link to={categoryHref(channel.category)} className="chip channel__category">
                  {channel.category}
                </Link>
              ) : null}
              {channel.mature ? (
                <span className="chip channel__mature" title="Контент для взрослых">
                  18+
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="channel__side">
          {live ? (
            <dl className="channel__metrics">
              <div className="metric metric--state">
                <dt className="visually-hidden">Статус</dt>
                <dd>
                  <StatusBadge state={state} size="lg" />
                </dd>
              </div>
              <div className="metric">
                <dt className="metric__label">{viewersWord(live.viewers)}</dt>
                <dd className="metric__value num">{formatCount(live.viewers)}</dd>
              </div>
              <div className="metric">
                <dt className="metric__label">в эфире</dt>
                <dd className="metric__value num">
                  <time dateTime={live.startedAt}>{uptime}</time>
                </dd>
              </div>
            </dl>
          ) : null}
          <div className="channel__follow">
            {own ? (
              <>
                <span className="channel__followers num">{followersLabel(channel.followers ?? 0)}</span>
                <Link to="/dashboard" className="btn btn--outline">
                  <SquarePlay aria-hidden="true" />
                  Открыть студию
                </Link>
              </>
            ) : (
              <>
                <span className="channel__followers num">{followersLabel(channel.followers ?? 0)}</span>
                <FollowButton
                  slug={channel.slug}
                  displayName={channel.displayName}
                  following={auth.status === 'authed' ? (info.viewer?.following ?? false) : null}
                  followers={channel.followers ?? 0}
                  onChange={(r) =>
                    setInfo((prev) =>
                      prev
                        ? {
                            ...prev,
                            channel: { ...prev.channel, followers: r.followers },
                            viewer: { following: r.following },
                          }
                        : prev,
                    )
                  }
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="tabs channel__tabs">
        <div className="tabs__list" role="tablist" aria-label="Разделы канала">
          {(
            [
              ['live', 'Эфир'],
              ['videos', 'Видео'],
            ] as const
          ).map(([t, text]) => (
            <button
              key={t}
              id={tabId(t)}
              type="button"
              role="tab"
              className="tabs__tab"
              aria-selected={tab === t}
              aria-controls={`${tabIds.base}-panel`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => selectTab(t)}
              onKeyDown={onTabKey}
            >
              {text}
              {t === 'live' && live ? <span className="live-dot" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <div className="tabs__panel" role="tabpanel" id={`${tabIds.base}-panel`} aria-labelledby={tabId(tab)}>
          {tab === 'videos' ? (
            <ChannelVideos slug={channel.slug} own={own} />
          ) : (
            <div className="channel__panels">
              {live ? (
                <>
                  <section className="panel" aria-labelledby="signal-h">
                    <h2 className="h-section" id="signal-h">
                      Источник
                    </h2>
                    <SourceChips live={live} />
                  </section>
                  <section className="panel" aria-labelledby="renditions-h">
                    <h2 className="h-section" id="renditions-h">
                      Доступные качества
                    </h2>
                    {live.renditions.length ? (
                      <RenditionLadder renditions={live.renditions} />
                    ) : (
                      <p className="muted channel__pending">Список появится, когда видео будет готово.</p>
                    )}
                  </section>
                </>
              ) : null}
              <ChannelAbout channel={channel} own={own} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceChips({ live }: { live: LiveInfo }) {
  const s = live.source;
  const items: { k: string; v: string }[] = [];
  const proto = protocolLabel(s.protocol);
  if (proto) items.push({ k: 'Протокол', v: proto });
  if (s.videoCodec) items.push({ k: 'Видео', v: codecLabel(s.videoCodec) });
  if (s.width && s.height) items.push({ k: 'Разрешение', v: `${s.width}×${s.height}` });
  const fps = formatFps(s.fps);
  if (fps) items.push({ k: 'Частота', v: fps });
  if (s.audioCodec) items.push({ k: 'Звук', v: codecLabel(s.audioCodec) });
  if (!items.length) return <p className="muted channel__pending">Параметры источника пока неизвестны.</p>;
  return (
    <dl className="source-grid">
      {items.map((i) => (
        <div key={i.k} className="source-grid__item">
          <dt>{i.k}</dt>
          <dd className="num">{i.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReconnectingNotice() {
  return (
    <div className="reconnecting" role="status">
      <span className="reconnecting__dot" aria-hidden="true" />
      <div>
        <strong>Стример переподключается…</strong>
        <span>Картинка вернётся сама, ждём до 30 секунд.</span>
      </div>
    </div>
  );
}

function OfflineStage({ last, onVideos }: { last: LastBroadcast | null; onVideos: () => void }) {
  return (
    <div className="stage stage--offline">
      <div className="offline">
        <p className="offline__headline">Сейчас не в эфире</p>
        {last ? (
          <div className="offline__last">
            <CalendarClock aria-hidden="true" />
            <p>
              Последний эфир {formatRelativeDay(last.endedAt)}
              {last.title ? <>: «{last.title}»</> : null}
              <span className="offline__when">
                {formatDateTime(last.startedAt)}, длился {formatDuration(sinceMs(last.startedAt, Date.parse(last.endedAt)))}
              </span>
            </p>
          </div>
        ) : null}
        {last ? (
          <button type="button" className="btn btn--outline btn--sm offline__videos" onClick={onVideos}>
            Смотреть записи
          </button>
        ) : (
          <p className="offline__hint">Здесь ещё не было трансляций.</p>
        )}
        <p className="offline__hint">Когда эфир начнётся, видео появится здесь само — обновлять страницу не нужно.</p>
      </div>
    </div>
  );
}
