import Hls, { ErrorDetails, ErrorTypes, Events, type Level } from 'hls.js';
import {
  Activity,
  Check,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { Rendition } from '../api/types';
import { readPref, writePref } from '../lib/browser';
import { useLatest } from '../lib/hooks';
import { codecLabel, formatDecimal, formatKbps, hlsCodecName } from '../lib/format';
import './Player.css';

export type PlayerProps = {
  /** master.m3u8 (relative URLs are fine). Changing it recreates the player. */
  src: string;
  renditions: Rendition[];
  /** Channel is live (not reconnecting). Enables the stall watchdog. */
  live: boolean;
  poster?: string | null;
  /** Dashboard preview: always muted, no sound affordance. */
  preview?: boolean;
  label: string;
  /** Rendered over the picture, under the controls (e.g. "reconnecting"). */
  overlay?: ReactNode;
  onPlaying?: () => void;
};

type LevelInfo = {
  index: number;
  name: string;
  height: number;
  width: number;
  bitrate: number;
  videoCodec: string | undefined;
};

type LevelOption = LevelInfo & { label: string; codec: string | null };

type Engine = 'hls' | 'native' | 'unsupported';

type Stats = {
  latency: number | null;
  buffer: number | null;
  bandwidth: number | null;
  dropped: number | null;
};

const STALL_LIMIT_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;

function snapshotLevels(levels: Level[]): LevelInfo[] {
  return levels.map((l, index) => ({
    index,
    name: l.name,
    height: l.height,
    width: l.width,
    bitrate: l.bitrate,
    videoCodec: l.videoCodec,
  }));
}

function labelLevels(levels: LevelInfo[], renditions: Rendition[]): LevelOption[] {
  return levels
    .map((l) => {
      const r = renditions.find((x) => x.name === l.name);
      const label = r?.label ?? (l.height ? `${l.height}p` : (formatKbps(l.bitrate / 1000) ?? l.name));
      const codec = r ? codecLabel(r.codec) : hlsCodecName(l.videoCodec);
      return { ...l, label, codec };
    })
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
}

function bufferAhead(video: HTMLVideoElement): number | null {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.1 && video.buffered.end(i) >= t) {
      return video.buffered.end(i) - t;
    }
  }
  return video.buffered.length ? 0 : null;
}

export function Player({
  src,
  renditions,
  live,
  poster,
  preview = false,
  label,
  overlay,
  onPlaying,
}: PlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const userPausedRef = useRef(false);
  const onPlayingRef = useLatest(onPlaying);

  const [generation, setGeneration] = useState(0);
  const [engine, setEngine] = useState<Engine>('hls');
  const [levels, setLevels] = useState<LevelInfo[]>([]);
  const [playingLevel, setPlayingLevel] = useState(-1);
  const [manualLevel, setManualLevel] = useState(-1);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(() => {
    const v = Number(readPref('volume'));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
  });
  const [paused, setPaused] = useState(true);
  const [buffering, setBuffering] = useState(true);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [behindLive, setBehindLive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const needsGestureRef = useLatest(needsGesture);
  // Retry counter survives player rebuilds so a dead master playlist backs off (1 s → 15 s)
  // instead of being re-requested every second. Reset once media actually flows.
  const attemptsRef = useRef(0);

  const recreate = useCallback(() => setGeneration((g) => g + 1), []);

  const levelOptions = useMemo(() => labelLevels(levels, renditions), [levels, renditions]);
  const current = levelOptions.find((l) => l.index === playingLevel) ?? null;
  const manual = levelOptions.find((l) => l.index === manualLevel) ?? null;

  const tryPlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || userPausedRef.current) return;
    const attempt = video.play();
    if (!attempt) return;
    attempt
      .then(() => setNeedsGesture(false))
      .catch((err: unknown) => {
        if (!(err instanceof DOMException) || err.name !== 'NotAllowedError') return;
        if (!video.muted) {
          // Unmuted autoplay blocked: fall back to muted autoplay.
          video.muted = true;
          setMuted(true);
          video.play().then(
            () => setNeedsGesture(false),
            () => setNeedsGesture(true),
          );
        } else {
          setNeedsGesture(true);
        }
      });
  }, []);

  // Sound preference: start muted (autoplay policy) unless the viewer chose sound before —
  // then try unmuted and fall back to muted if the browser refuses.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const wantsSound = !preview && readPref('sound') === 'on';
    video.muted = !wantsSound;
    video.volume = volume;
    setMuted(video.muted);
  }, [preview]); // volume intentionally read once

  // --- Engine lifecycle: (re)created when src or generation changes. ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let retryTimer: number | undefined;
    let mediaErrors: number[] = [];

    setLevels([]);
    setPlayingLevel(-1);
    setFatal(null);
    setBuffering(true);

    const schedule = (fn: () => void) => {
      const delay = Math.min(1000 * 2 ** attemptsRef.current, MAX_BACKOFF_MS);
      attemptsRef.current += 1;
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        if (!disposed) fn();
      }, delay);
    };

    if (Hls.isSupported()) {
      setEngine('hls');
      const hls = new Hls({
        capLevelToPlayerSize: preview,
        backBufferLength: 30,
        liveDurationInfinity: true,
        // Gently catch up when we drift behind the live edge.
        maxLiveSyncPlaybackRate: 1.05,
      });
      hlsRef.current = hls;

      const syncLevels = () => {
        setLevels(snapshotLevels(hls.levels));
      };
      hls.on(Events.MANIFEST_PARSED, () => {
        syncLevels();
        setManualLevel(-1);
        tryPlay();
      });
      hls.on(Events.LEVELS_UPDATED, syncLevels);
      hls.on(Events.LEVEL_SWITCHED, (_e, data) => setPlayingLevel(data.level));
      hls.on(Events.FRAG_LOADED, () => {
        attemptsRef.current = 0;
        setRecovering(false);
      });
      hls.on(Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.details === ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR) {
          setFatal(
            'Этот браузер не умеет декодировать ни одно из доступных качеств. Попробуйте другой браузер или попросите стримера включить режим ABR.',
          );
          return;
        }
        setRecovering(true);
        switch (data.type) {
          case ErrorTypes.NETWORK_ERROR:
            if (
              data.details === ErrorDetails.MANIFEST_LOAD_ERROR ||
              data.details === ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
              data.details === ErrorDetails.MANIFEST_PARSING_ERROR
            ) {
              // Master playlist itself failed — start over from scratch.
              schedule(recreate);
            } else {
              schedule(() => hls.startLoad());
            }
            break;
          case ErrorTypes.MEDIA_ERROR: {
            const now = Date.now();
            mediaErrors = mediaErrors.filter((t) => now - t < 15_000);
            mediaErrors.push(now);
            if (mediaErrors.length === 1) {
              hls.recoverMediaError();
            } else if (mediaErrors.length === 2) {
              hls.swapAudioCodec();
              hls.recoverMediaError();
            } else {
              schedule(recreate);
            }
            break;
          }
          default:
            schedule(recreate);
        }
      });

      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      setEngine('native');
      video.src = src;
      const onMeta = () => {
        attemptsRef.current = 0;
        tryPlay();
      };
      video.addEventListener('loadedmetadata', onMeta, { once: true });
      const onError = () => schedule(recreate);
      video.addEventListener('error', onError);
      return () => {
        disposed = true;
        window.clearTimeout(retryTimer);
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('error', onError);
        video.removeAttribute('src');
        video.load();
      };
    } else {
      setEngine('unsupported');
      setFatal('Этот браузер не умеет воспроизводить HLS. Откройте страницу в Chrome, Firefox, Edge или Safari.');
    }

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src, generation, preview, tryPlay, recreate]);

  // --- Media element events ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    const onWaiting = () => setBuffering(true);
    const onPlayingEv = () => {
      setBuffering(false);
      setRecovering(false);
      setPaused(false);
      setNeedsGesture(false);
      onPlayingRef.current?.();
    };
    const onCanPlay = () => setBuffering(false);
    const onVolume = () => {
      setMuted(video.muted);
      setVolume(video.volume);
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlayingEv);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('volumechange', onVolume);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlayingEv);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('volumechange', onVolume);
    };
  }, [onPlayingRef]);

  // --- Stall watchdog: if the picture hasn't moved for 10 s while live, rebuild from master. ---
  useEffect(() => {
    if (!live || fatal) return;
    let lastTime = -1;
    let lastProgress = Date.now();
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const now = Date.now();
      if (document.hidden || userPausedRef.current || needsGestureRef.current) {
        lastProgress = now;
        lastTime = video.currentTime;
        return;
      }
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastProgress = now;
        return;
      }
      if (now - lastProgress >= STALL_LIMIT_MS) {
        lastProgress = now;
        setRecovering(true);
        recreate();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [live, fatal, recreate]);

  // --- Live-edge tracking + stats sampling (1 Hz). ---
  useEffect(() => {
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const hls = hlsRef.current;
      let edge: number | null = null;
      if (hls) edge = hls.liveSyncPosition;
      else if (video.seekable.length) edge = video.seekable.end(video.seekable.length - 1) - 6;
      setBehindLive(edge != null && edge - video.currentTime > 12);

      if (statsOpen) {
        const q = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
        setStats({
          latency: hls && Number.isFinite(hls.latency) && hls.latency > 0 ? hls.latency : null,
          buffer: bufferAhead(video),
          bandwidth: hls && Number.isFinite(hls.bandwidthEstimate) ? hls.bandwidthEstimate : null,
          dropped: q ? q.droppedVideoFrames : null,
        });
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [statsOpen]);

  // --- Fullscreen state ---
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // --- Auto-hide controls while playing ---
  const idleTimer = useRef<number | undefined>(undefined);
  const poke = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 3000);
  }, []);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  // --- Actions ---
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      userPausedRef.current = false;
      // After a long pause, jump back to live instead of resuming stale buffer.
      const hls = hlsRef.current;
      if (hls?.liveSyncPosition != null && hls.liveSyncPosition - video.currentTime > 12) {
        video.currentTime = hls.liveSyncPosition;
      }
      tryPlay();
    } else {
      userPausedRef.current = true;
      video.pause();
    }
  }, [tryPlay]);

  const setSound = useCallback(
    (on: boolean) => {
      const video = videoRef.current;
      if (!video || preview) return;
      video.muted = !on;
      if (on && video.volume === 0) video.volume = 1;
      writePref('sound', on ? 'on' : 'off');
      if (on && video.paused && !userPausedRef.current) tryPlay();
    },
    [preview, tryPlay],
  );

  const changeVolume = (v: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = v;
    video.muted = v === 0;
    writePref('volume', String(v || 1));
    writePref('sound', v === 0 ? 'off' : 'on');
  };

  const goLive = () => {
    const video = videoRef.current;
    if (!video) return;
    const hls = hlsRef.current;
    if (hls?.liveSyncPosition != null) video.currentTime = hls.liveSyncPosition;
    else if (video.seekable.length) video.currentTime = video.seekable.end(video.seekable.length - 1) - 3;
    userPausedRef.current = false;
    tryPlay();
  };

  const toggleFullscreen = () => {
    const root = rootRef.current;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (root.requestFullscreen) {
      void root.requestFullscreen().catch(() => undefined);
    } else {
      video?.webkitEnterFullscreen?.();
    }
  };

  const chooseLevel = (index: number) => {
    const hls = hlsRef.current;
    setManualLevel(index);
    if (hls) hls.currentLevel = index; // -1 = auto
    setMenuOpen(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    poke();
    const target = e.target as HTMLElement;
    if (target.closest('input, select, textarea, [role="menu"]')) return;
    const onButton = target.closest('button');
    switch (e.key) {
      case 'k':
      case 'л':
        togglePlay();
        break;
      case ' ':
        if (onButton) return;
        e.preventDefault();
        togglePlay();
        break;
      case 'm':
      case 'ь':
        setSound(muted);
        break;
      case 'f':
      case 'а':
        toggleFullscreen();
        break;
      default:
        return;
    }
  };

  const showSoundPrompt = !preview && muted && !needsGesture && !fatal;
  const showBigPlay = !fatal && (needsGesture || (paused && userPausedRef.current));
  const showSpinner = !fatal && !showBigPlay && (buffering || recovering);
  const controlsHidden = idle && !paused && !menuOpen && !statsOpen;

  const qualityLabel =
    manualLevel === -1 ? (current ? `Авто · ${current.height}p` : 'Авто') : (manual?.label ?? 'Качество');

  const statsLevel = current;

  return (
    <div
      ref={rootRef}
      className="player"
      data-controls-hidden={controlsHidden ? 'true' : 'false'}
      data-preview={preview ? 'true' : 'false'}
      tabIndex={0}
      role="region"
      aria-label={label}
      onKeyDown={onKeyDown}
      onPointerMove={poke}
      onPointerDown={poke}
      onFocus={poke}
    >
      <video
        ref={videoRef}
        className="player__video"
        playsInline
        muted
        poster={poster ?? undefined}
        onClick={() => {
          if (!preview) togglePlay();
        }}
        onDoubleClick={toggleFullscreen}
        aria-hidden="true"
        tabIndex={-1}
      />

      {overlay ? <div className="player__overlay">{overlay}</div> : null}

      {showSpinner ? (
        <div className="player__center" aria-hidden="true">
          <div className="spinner" />
        </div>
      ) : null}

      {showBigPlay ? (
        <div className="player__center">
          <button type="button" className="player__bigplay" onClick={togglePlay} aria-label="Смотреть">
            <Play aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {fatal ? (
        <div className="player__fatal" role="alert">
          <p>{fatal}</p>
          {engine !== 'unsupported' ? (
            <button type="button" className="btn btn--sm" onClick={recreate}>
              <RotateCcw aria-hidden="true" />
              Повторить
            </button>
          ) : null}
        </div>
      ) : null}

      {showSoundPrompt ? (
        <button type="button" className="player__unmute" onClick={() => setSound(true)}>
          <VolumeX aria-hidden="true" />
          Включить звук
        </button>
      ) : null}

      {statsOpen ? (
        <div className="player__stats" role="status" aria-live="off">
          <div className="player__stats-head">
            <span>Статистика</span>
            <button
              type="button"
              className="player__stats-close"
              onClick={() => setStatsOpen(false)}
              aria-label="Скрыть статистику"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <dl>
            <div>
              <dt>Задержка</dt>
              <dd>{stats?.latency != null ? `${formatDecimal(stats.latency)} с` : '—'}</dd>
            </div>
            <div>
              <dt>Буфер</dt>
              <dd>{stats?.buffer != null ? `${formatDecimal(stats.buffer)} с` : '—'}</dd>
            </div>
            <div>
              <dt>Качество</dt>
              <dd>
                {statsLevel
                  ? `${statsLevel.width}×${statsLevel.height}${statsLevel.codec ? ` ${statsLevel.codec}` : ''}`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Битрейт</dt>
              <dd>{statsLevel ? (formatKbps(statsLevel.bitrate / 1000) ?? '—') : '—'}</dd>
            </div>
            <div>
              <dt>Канал</dt>
              <dd>{stats?.bandwidth != null ? (formatKbps(stats.bandwidth / 1000) ?? '—') : '—'}</dd>
            </div>
            <div>
              <dt>Потеряно кадров</dt>
              <dd>{stats?.dropped ?? '—'}</dd>
            </div>
            <div>
              <dt>Движок</dt>
              <dd>{engine === 'hls' ? `hls.js ${Hls.version}` : engine === 'native' ? 'встроенный HLS' : '—'}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="player__controls">
        <button
          type="button"
          className="player__btn"
          onClick={togglePlay}
          aria-label={paused ? 'Смотреть' : 'Пауза'}
          title={paused ? 'Смотреть (k)' : 'Пауза (k)'}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </button>

        {!preview ? (
          <div className="player__volume">
            <button
              type="button"
              className="player__btn"
              onClick={() => setSound(muted)}
              aria-label={muted ? 'Включить звук' : 'Выключить звук'}
              title={muted ? 'Включить звук (m)' : 'Выключить звук (m)'}
            >
              {muted || volume === 0 ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
            </button>
            <input
              className="player__range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              aria-label="Громкость"
            />
          </div>
        ) : null}

        {behindLive ? (
          <button type="button" className="player__golive" onClick={goLive}>
            <span className="player__golive-dot" aria-hidden="true" />
            К прямому эфиру
          </button>
        ) : null}

        <span className="player__spacer" />

        {engine === 'hls' && levelOptions.length > 0 ? (
          <QualityMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            buttonLabel={qualityLabel}
            options={levelOptions}
            manualLevel={manualLevel}
            current={current}
            onChoose={chooseLevel}
          />
        ) : null}

        <button
          type="button"
          className="player__btn"
          onClick={() => setStatsOpen((v) => !v)}
          aria-pressed={statsOpen}
          aria-label="Статистика воспроизведения"
          title="Статистика"
        >
          <Activity aria-hidden="true" />
        </button>

        {!preview ? (
          <button
            type="button"
            className="player__btn"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Выйти из полноэкранного режима' : 'Во весь экран'}
            title={fullscreen ? 'Выйти из полноэкранного режима (f)' : 'Во весь экран (f)'}
          >
            {fullscreen ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type QualityMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buttonLabel: string;
  options: LevelOption[];
  manualLevel: number;
  current: LevelOption | null;
  onChoose: (index: number) => void;
};

function QualityMenu({
  open,
  onOpenChange,
  buttonLabel,
  options,
  manualLevel,
  current,
  onChoose,
}: QualityMenuProps) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus the checked item when opened; close on outside click.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const checked = menu?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? menu?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, onOpenChange]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [],
    );
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      onOpenChange(false);
      buttonRef.current?.focus();
    }
  };

  const pick = (index: number) => {
    onChoose(index);
    buttonRef.current?.focus();
  };

  return (
    <div className="qmenu">
      <button
        ref={buttonRef}
        type="button"
        className="player__btn player__btn--text"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => onOpenChange(!open)}
        title="Качество"
      >
        <Settings2 aria-hidden="true" />
        <span className="player__btn-label">{buttonLabel}</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="qmenu__list"
          role="menu"
          aria-label="Качество"
          onKeyDown={onMenuKey}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={manualLevel === -1}
            className="qmenu__item"
            tabIndex={-1}
            onClick={() => pick(-1)}
          >
            <span className="qmenu__check">{manualLevel === -1 ? <Check aria-hidden="true" /> : null}</span>
            <span className="qmenu__label">
              Авто
              {current ? (
                <span className="qmenu__sub">
                  сейчас {current.height}p{current.codec ? `, ${current.codec}` : ''}
                </span>
              ) : null}
            </span>
          </button>
          {options.map((o) => (
            <button
              key={o.index}
              type="button"
              role="menuitemradio"
              aria-checked={manualLevel === o.index}
              className="qmenu__item"
              tabIndex={-1}
              onClick={() => pick(o.index)}
            >
              <span className="qmenu__check">
                {manualLevel === o.index ? <Check aria-hidden="true" /> : null}
              </span>
              <span className="qmenu__label">{o.label}</span>
              {o.codec && !o.label.includes(o.codec) ? <span className="qmenu__codec">{o.codec}</span> : null}
              {manualLevel === -1 && current?.index === o.index ? (
                <span className="qmenu__now" aria-label="воспроизводится сейчас" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
