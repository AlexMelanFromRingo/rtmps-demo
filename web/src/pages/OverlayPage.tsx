import { Eye, Heart } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { OverlayAlertEvent, OverlayStatsEvent } from '../api/types';
import { formatCount, viewersWord } from '../lib/format';
import './OverlayPage.css';

/** The server pings every 15 s; this much silence means a dead connection. */
const SILENCE_MS = 40_000;
const ALERT_MS = 5_000;
const ALERT_EXIT_MS = 450;
const MAX_QUEUE = 20;

type QueuedAlert = OverlayAlertEvent & { key: number };

type Conn = 'connecting' | 'open' | 'invalid';

/** Short two-note chime synthesised with WebAudio (no audio files). */
function playChime(ctxRef: { current: AudioContext | null }) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    ctxRef.current ??= new Ctx();
    const ctx = ctxRef.current;
    void ctx.resume();
    const t = ctx.currentTime + 0.02;
    const notes: [number, number][] = [
      [987.77, 0], // B5
      [1318.51, 0.13], // E6
    ];
    for (const [freq, delay] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.22, t + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.7);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.75);
    }
  } catch {
    /* audio is optional */
  }
}

/** Transparent page for OBS: no site chrome, no background. */
function useTransparentPage() {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('overlay-mode');
    // A dark colour-scheme would make the canvas behind the page opaque.
    const meta = document.querySelector('meta[name="color-scheme"]');
    const prev = meta?.getAttribute('content') ?? null;
    meta?.setAttribute('content', 'normal');
    document.title = 'StreamHub — оверлей';
    return () => {
      html.classList.remove('overlay-mode');
      if (meta && prev) meta.setAttribute('content', prev);
    };
  }, []);
}

export function OverlayPage() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const showAlerts = params.get('alerts') !== '0';
  const showViewers = params.get('viewers') !== '0';
  const sound = params.get('sound') !== '0';
  useTransparentPage();

  const [conn, setConn] = useState<Conn>('connecting');
  const [stats, setStats] = useState<OverlayStatsEvent | null>(null);
  const [queue, setQueue] = useState<QueuedAlert[]>([]);
  const [current, setCurrent] = useState<QueuedAlert | null>(null);
  const [leaving, setLeaving] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const keyRef = useRef(0);

  // --- Event stream with backoff, silence watchdog and invalid-token detection. ---
  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(token)) {
      console.error('[StreamHub overlay] Неверная ссылка оверлея: скопируйте её заново в студии.');
      setConn('invalid');
      return;
    }
    const url = api.overlayEventsUrl(token);
    let es: EventSource | null = null;
    let retryTimer: number | undefined;
    let retries = 0;
    let disposed = false;
    let lastEventAt = Date.now();

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(1000 * 2 ** retries, 30_000);
      retries += 1;
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(connect, delay);
    };

    /** EventSource can't tell a 404 from a network failure; ask once with fetch. */
    const probe = async () => {
      const ctrl = new AbortController();
      try {
        const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal, cache: 'no-store' });
        ctrl.abort();
        if (res.status === 404) {
          console.error('[StreamHub overlay] Ссылка оверлея недействительна (её сбросили в студии?). Скопируйте новую.');
          if (!disposed) setConn('invalid');
          return;
        }
      } catch {
        /* network: just retry */
      }
      scheduleReconnect();
    };

    const connect = () => {
      if (disposed) return;
      es?.close();
      lastEventAt = Date.now();
      setConn('connecting');
      es = new EventSource(url);
      es.addEventListener('open', () => {
        retries = 0;
        lastEventAt = Date.now();
        setConn('open');
      });
      es.addEventListener('ping', () => {
        lastEventAt = Date.now();
      });
      es.addEventListener('stats', (e) => {
        lastEventAt = Date.now();
        try {
          const data = JSON.parse((e as MessageEvent<string>).data) as OverlayStatsEvent;
          setStats({ live: Boolean(data.live), viewers: Number(data.viewers) || 0 });
        } catch {
          /* ignore malformed event */
        }
      });
      es.addEventListener('alert', (e) => {
        lastEventAt = Date.now();
        try {
          const data = JSON.parse((e as MessageEvent<string>).data) as OverlayAlertEvent;
          if (data.type !== 'follow' || !data.displayName) return;
          keyRef.current += 1;
          const item = { ...data, key: keyRef.current };
          setQueue((q) => [...q, item].slice(-MAX_QUEUE));
        } catch {
          /* ignore malformed event */
        }
      });
      es.addEventListener('error', () => {
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          void probe();
        }
        // CONNECTING: the browser retries on its own.
      });
    };

    connect();
    const watchdog = window.setInterval(() => {
      if (!es || Date.now() - lastEventAt < SILENCE_MS) return;
      console.warn('[StreamHub overlay] Нет событий 40 с — переподключаемся.');
      es.close();
      es = null;
      scheduleReconnect();
    }, 5_000);

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(watchdog);
      es?.close();
    };
  }, [token]);

  // --- Alert queue: one card at a time, ~5 s each. ---
  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    if (!showAlerts || !next) return;
    setLeaving(false);
    setCurrent(next);
    if (sound) playChime(audioRef);
  }, [queue, current, showAlerts, sound]);

  useEffect(() => {
    if (!current) return;
    const exit = window.setTimeout(() => setLeaving(true), ALERT_MS);
    const done = window.setTimeout(() => {
      setCurrent(null);
      setLeaving(false);
    }, ALERT_MS + ALERT_EXIT_MS);
    return () => {
      window.clearTimeout(exit);
      window.clearTimeout(done);
    };
  }, [current]);

  // OBS plays audio without a gesture; a normal browser tab (preview) needs one click first.
  useEffect(() => {
    if (!sound) return;
    const unlock = () => {
      const Ctx = window.AudioContext;
      if (!Ctx) return;
      audioRef.current ??= new Ctx();
      void audioRef.current.resume();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, [sound]);

  useEffect(
    () => () => {
      void audioRef.current?.close();
    },
    [],
  );

  if (conn === 'invalid') return null;

  return (
    <div className="ovl">
      {showViewers && stats?.live ? (
        <div className="ovl__viewers" aria-label={`${formatCount(stats.viewers)} ${viewersWord(stats.viewers)}`}>
          <span className="ovl__tally" aria-hidden="true" />
          <Eye aria-hidden="true" />
          <span className="ovl__count num">{formatCount(stats.viewers)}</span>
        </div>
      ) : null}

      <div className="ovl__stage" role="status" aria-live="polite">
        {current ? (
          <div key={current.key} className="ovl__alert" data-leaving={leaving ? 'true' : 'false'}>
            <span className="ovl__bar" aria-hidden="true" />
            <span className="ovl__badge" aria-hidden="true">
              <Heart fill="currentColor" />
            </span>
            <p className="ovl__line">
              <span className="ovl__name">{current.displayName}</span> подписался!
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
