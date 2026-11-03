import Hls, { ErrorDetails, ErrorTypes, Events, type HlsConfig, type Level } from 'hls.js';
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
  Zap,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { Rendition } from '../api/types';
import { readPref, readVodPosition, writePref, writeVodPosition } from '../lib/browser';
import { useLatest } from '../lib/hooks';
import {
  codecLabel,
  formatClock,
  formatDecimal,
  formatKbps,
  hlsCodecName,
  spokenClock,
} from '../lib/format';
import './Player.css';

export type PlayerProps = {
  /** master.m3u8 (relative URLs are fine). Changing it recreates the player. */
  src: string;
  renditions: Rendition[];
  /** Channel is live (not reconnecting). Enables the stall watchdog. Always false for VOD. */
  live: boolean;
  /** `vod`: a finished recording — seek bar, timecode, no live-edge logic. */
  mode?: 'live' | 'vod';
  /** Live only: the stream uses 1 s segments, so hold the player close to the edge. */
  lowLatency?: boolean;
  poster?: string | null;
  /** Dashboard preview: always muted, no sound affordance. */
  preview?: boolean;
  label: string;
  /** Rendered over the picture, under the controls (e.g. "reconnecting"). */
  overlay?: ReactNode;
  onPlaying?: () => void;
  /** VOD: remember and restore the playback position under this id. */
  resumeId?: string;
  /** VOD: duration from the API, used until the media reports its own. */
  durationHint?: number;
  /** Called once after `watchSeconds` of actual playback (seeking doesn't count). */
  onWatched?: () => void;
  watchSeconds?: number;
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
const SEEK_STEP_S = 10;
/** Don't offer to resume within the first/last few seconds of a recording. */
const RESUME_MIN_S = 5;
const RESUME_TAIL_S = 10;

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

/** End of the buffered range that contains the playhead (for the seek bar). */
function bufferedEnd(video: HTMLVideoElement): number {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.5 && video.buffered.end(i) >= t) return video.buffered.end(i);
  }
  return t;
}

/** hls.js tuning per playback mode. */
function hlsConfig(mode: 'live' | 'vod', lowLatency: boolean, preview: boolean, startAt: number | null): Partial<HlsConfig> {
  if (mode === 'vod') {
    return {
      capLevelToPlayerSize: preview,
      backBufferLength: 60,
      maxBufferLength: 30,
      ...(startAt != null ? { startPosition: startAt } : {}),
    };
  }
  if (lowLatency) {
    // Regular (non-LL) HLS with 1 s segments: sit ~2 segments behind the edge,
    // jump back in when drifting past 5, and catch up a little faster.
    return {
      capLevelToPlayerSize: preview,
      liveDurationInfinity: true,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 5,
      maxLiveSyncPlaybackRate: 1.1,
      maxBufferLength: 4,
      maxMaxBufferLength: 8,
      backBufferLength: 10,
    };
  }
  return {
    capLevelToPlayerSize: preview,
    backBufferLength: 30,
    liveDurationInfinity: true,
    // Gently catch up when we drift behind the live edge.
    maxLiveSyncPlaybackRate: 1.05,
  };
}

export function Player({
  src,
  renditions,
  live,
  mode = 'live',
  lowLatency = false,
  poster,
  preview = false,
  label,
  overlay,
  onPlaying,
  resumeId,
  durationHint,
  onWatched,
  watchSeconds = 10,
}: PlayerProps) {
  const isVod = mode === 'vod';
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const userPausedRef = useRef(false);
  const onPlayingRef = useLatest(onPlaying);
  const onWatchedRef = useLatest(onWatched);

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
  const [ended, setEnded] = useState(false);
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
  // VOD timeline
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [buffered, setBuffered] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const needsGestureRef = useLatest(needsGesture);
  // Retry counter survives player rebuilds so a dead master playlist backs off (1 s → 15 s)
  // instead of being re-requested every second. Reset once media actually flows.
  const attemptsRef = useRef(0);
  // Where to start a VOD: the remembered position, read once per src.
  const startAtRef = useRef<{ src: string; at: number | null } | null>(null);

  const duration =
    mediaDuration != null && Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : (durationHint ?? 0);
  const durationRef = useLatest(duration);

  const recreate = useCallback(() => setGeneration((g) => g + 1), []);

  const levelOptions = useMemo(() => labelLevels(levels, renditions), [levels, renditions]);
  const current = levelOptions.find((l) => l.index === playingLevel) ?? null;
  const manual = levelOptions.find((l) => l.index === manualLevel) ?? null;

  if (isVod && resumeId && startAtRef.current?.src !== src) {
    const saved = readVodPosition(resumeId);
    const limit = durationHint ? durationHint - RESUME_TAIL_S : Infinity;
    startAtRef.current = { src, at: saved != null && saved > RESUME_MIN_S && saved < limit ? saved : null };
  }

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

  // --- VOD timeline + resume position ---
  // Declared before the engine effect so its cleanup (final save) runs before hls.js detaches.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVod) return;
    let lastSaved = 0;
    const save = (force = false) => {
      if (!resumeId) return;
      const t = video.currentTime;
      const d = durationRef.current;
      if (!force && Math.abs(t - lastSaved) < 5) return;
      lastSaved = t;
      if (video.ended || (d > 0 && t > d - RESUME_TAIL_S) || t < RESUME_MIN_S) writeVodPosition(resumeId, null);
      else writeVodPosition(resumeId, t);
    };
    const onTime = () => {
      setCurrentTime(video.currentTime);
      setBuffered(bufferedEnd(video));
      if (!video.paused) save();
    };
    const onProgress = () => setBuffered(bufferedEnd(video));
    const onDuration = () => setMediaDuration(Number.isFinite(video.duration) ? video.duration : null);
    const onPauseSave = () => save(true);
    const onHide = () => save(true);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onTime);
    video.addEventListener('progress', onProgress);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('loadedmetadata', onDuration);
    video.addEventListener('pause', onPauseSave);
    video.addEventListener('ended', onPauseSave);
    window.addEventListener('pagehide', onHide);
    return () => {
      // Saving on unmount needs a playhead that was actually reached.
      if (video.currentTime > 0) save(true);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onTime);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('loadedmetadata', onDuration);
      video.removeEventListener('pause', onPauseSave);
      video.removeEventListener('ended', onPauseSave);
      window.removeEventListener('pagehide', onHide);
    };
  }, [isVod, resumeId, src, durationRef]);

  // --- Engine lifecycle: (re)created when src or generation changes. ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let retryTimer: number | undefined;
    let mediaErrors: number[] = [];
    // On a rebuild, continue from where we were (VOD); on first load, from the saved position.
    const startAt = isVod
      ? video.currentTime > 0
        ? video.currentTime
        : (startAtRef.current?.at ?? null)
      : null;
    const resuming = isVod && video.currentTime === 0 && startAt != null;

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
      const hls = new Hls(hlsConfig(mode, lowLatency, preview, startAt));
      hlsRef.current = hls;

      const syncLevels = () => {
        setLevels(snapshotLevels(hls.levels));
      };
      hls.on(Events.MANIFEST_PARSED, () => {
        syncLevels();
        setManualLevel(-1);
        if (resuming && startAt != null) setResumedFrom(startAt);
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
        if (startAt != null) {
          video.currentTime = startAt;
          if (resuming) setResumedFrom(startAt);
        }
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
  }, [src, generation, preview, mode, lowLatency, isVod, tryPlay, recreate]);

  // --- Media element events ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => {
      setPaused(false);
      setEnded(false);
    };
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
    const onEnded = () => {
      setEnded(true);
      userPausedRef.current = true;
    };
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlayingEv);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('ended', onEnded);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlayingEv);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('ended', onEnded);
    };
  }, [onPlayingRef]);

  // --- Watch time (for view counting): only real playback, seeks excluded. ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onWatchedRef.current) return;
    let last = video.currentTime;
    let watched = 0;
    let fired = false;
    const onTime = () => {
      const t = video.currentTime;
      const delta = t - last;
      last = t;
      if (fired || video.paused || video.seeking) return;
      if (delta > 0 && delta < 2) watched += delta;
      if (watched >= watchSeconds) {
        fired = true;
        onWatchedRef.current?.();
      }
    };
    const onSeeked = () => {
      last = video.currentTime;
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onSeeked);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onSeeked);
    };
  }, [src, watchSeconds, onWatchedRef]);


  useEffect(() => {
    if (resumedFrom == null) return;
    const t = window.setTimeout(() => setResumedFrom(null), 7000);
    return () => window.clearTimeout(t);
  }, [resumedFrom]);

  // --- Stall watchdog: if the picture hasn't moved for 10 s while live, rebuild from master. ---
  useEffect(() => {
    if (!live || isVod || fatal) return;
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
  }, [live, isVod, fatal, recreate]);

  // --- Live-edge tracking + stats sampling (1 Hz). ---
  const behindLimit = lowLatency ? 6 : 12;
  useEffect(() => {
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const hls = hlsRef.current;
      if (!isVod) {
        let edge: number | null = null;
        if (hls) edge = hls.liveSyncPosition;
        else if (video.seekable.length) edge = video.seekable.end(video.seekable.length - 1) - 6;
        setBehindLive(edge != null && edge - video.currentTime > behindLimit);
      }

      if (statsOpen) {
        const q = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
        setStats({
          latency: !isVod && hls && Number.isFinite(hls.latency) && hls.latency > 0 ? hls.latency : null,
          buffer: bufferAhead(video),
          bandwidth: hls && Number.isFinite(hls.bandwidthEstimate) ? hls.bandwidthEstimate : null,
          dropped: q ? q.droppedVideoFrames : null,
        });
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [statsOpen, isVod, behindLimit]);

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
      if (!isVod && hls?.liveSyncPosition != null && hls.liveSyncPosition - video.currentTime > 12) {
        video.currentTime = hls.liveSyncPosition;
      }
      tryPlay();
    } else {
      userPausedRef.current = true;
      video.pause();
    }
  }, [tryPlay, isVod]);

  const seekTo = useCallback(
    (t: number) => {
      const video = videoRef.current;
      if (!video) return;
      const d = durationRef.current;
      const target = Math.max(0, d > 0 ? Math.min(t, d - 0.25) : t);
      video.currentTime = target;
      setCurrentTime(target);
      setResumedFrom(null);
    },
    [durationRef],
  );

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
    const onSeekBar = target.classList.contains('player__seek-input');
    if (!onSeekBar && target.closest('input, select, textarea, [role="menu"]')) return;
    const onButton = target.closest('button');
    const video = videoRef.current;
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
      case 'ArrowLeft':
      case 'j':
      case 'о':
        if (!isVod || !video) return;
        e.preventDefault();
        seekTo(video.currentTime - SEEK_STEP_S);
        break;
      case 'ArrowRight':
      case 'l':
      case 'д':
        if (!isVod || !video) return;
        e.preventDefault();
        seekTo(video.currentTime + SEEK_STEP_S);
        break;
      case 'Home':
        if (!isVod) return;
        e.preventDefault();
        seekTo(0);
        break;
      case 'End':
        if (!isVod) return;
        e.preventDefault();
        seekTo(durationRef.current);
        break;
      default:
        return;
    }
  };

  const showSoundPrompt = !preview && muted && !needsGesture && !fatal;
  const showBigPlay = !fatal && (needsGesture || (paused && userPausedRef.current));
  const showSpinner = !fatal && !showBigPlay && (buffering || recovering);
  const controlsHidden = idle && !paused && !menuOpen && !statsOpen && scrub === null;

  const qualityLabel =
    manualLevel === -1 ? (current ? `Авто · ${current.height}p` : 'Авто') : (manual?.label ?? 'Качество');

  const statsLevel = current;
  const shownTime = scrub ?? currentTime;

  return (
    <div
      ref={rootRef}
      className="player"
      data-mode={mode}
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
          <button
            type="button"
            className="player__bigplay"
            onClick={togglePlay}
            aria-label={ended ? 'Смотреть сначала' : 'Смотреть'}
          >
            {ended ? <RotateCcw aria-hidden="true" className="player__replay" /> : <Play aria-hidden="true" />}
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

      {resumedFrom != null && !fatal ? (
        <div className="player__resume" role="status">
          <span>
            Продолжаем с <span className="num">{formatClock(resumedFrom)}</span>
          </span>
          <button type="button" className="player__resume-btn" onClick={() => seekTo(0)}>
            Смотреть с начала
          </button>
        </div>
      ) : null}

      {statsOpen ? (
        <div className="player__stats" role="status" aria-live="off">
          <div className="player__stats-head">
            <span>Статистика</span>
            {lowLatency && !isVod ? (
              <span className="player__ll" title="Эфир идёт с короткими сегментами, плеер держится у края">
                <Zap aria-hidden="true" />
                Низкая задержка
              </span>
            ) : null}
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
            {!isVod ? (
              <div>
                <dt>Задержка</dt>
                <dd>{stats?.latency != null ? `${formatDecimal(stats.latency)} с` : '—'}</dd>
              </div>
            ) : null}
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
        {isVod ? (
          <SeekBar
            time={shownTime}
            duration={duration}
            buffered={buffered}
            onScrub={setScrub}
            onCommit={(t) => {
              setScrub(null);
              seekTo(t);
            }}
          />
        ) : null}

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

        {isVod ? (
          <span className="player__time num" aria-hidden="true">
            {formatClock(shownTime)}
            <span className="player__time-sep"> / </span>
            {formatClock(duration)}
          </span>
        ) : null}

        {!isVod && behindLive ? (
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

type SeekBarProps = {
  time: number;
  duration: number;
  buffered: number;
  /** Dragging: preview position (null when the drag ends). */
  onScrub: (t: number | null) => void;
  onCommit: (t: number) => void;
};

/**
 * VOD timeline: a native range input (keyboard + screen readers; arrow keys are handled
 * by the player as ±10 s) layered over a drawn track with buffered/played fills.
 */
function SeekBar({ time, duration, buffered, onScrub, onCommit }: SeekBarProps) {
  const draggingRef = useRef(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const d = duration > 0 ? duration : 0;
  const pct = (v: number) => (d ? `${Math.min(100, Math.max(0, (v / d) * 100))}%` : '0%');

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!d || e.pointerType === 'touch') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover({ x: frac * rect.width, t: frac * d });
  };

  const end = (value: number) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onScrub(null);
    onCommit(value);
  };

  return (
    <div className="player__seek" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <div className="player__track" aria-hidden="true">
        <span className="player__buffered" style={{ width: pct(buffered) }} />
        <span className="player__played" style={{ width: pct(time) }} />
        <span className="player__head" style={{ left: pct(time) }} />
      </div>
      <input
        className="player__seek-input"
        type="range"
        min={0}
        max={d || 1}
        step="any"
        value={Math.min(time, d || 1)}
        disabled={!d}
        aria-label="Перемотка"
        aria-valuetext={`${spokenClock(time)} из ${spokenClock(d)}`}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        onPointerUp={(e) => end(Number(e.currentTarget.value))}
        onPointerCancel={(e) => end(Number(e.currentTarget.value))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (draggingRef.current) onScrub(v);
          else onCommit(v);
        }}
      />
      {hover ? (
        <span className="player__seek-tip num" style={{ left: hover.x }} aria-hidden="true">
          {formatClock(hover.t)}
        </span>
      ) : null}
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
