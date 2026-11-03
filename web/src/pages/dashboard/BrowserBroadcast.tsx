import { Camera, Monitor, Square, TriangleAlert, Video } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DashboardLive, IngestInfo } from '../../api/types';
import { readPref, writePref } from '../../lib/browser';
import { codecLabel, formatFps, formatKbps, protocolLabel } from '../../lib/format';
import {
  WhipError,
  WhipSession,
  canPublishFromBrowser,
  mixAudioTracks,
  sendableVideoCodecs,
  type OutboundStats,
} from '../../lib/whip';

type Source = 'camera' | 'screen';
type Resolution = '720' | '1080';
type Phase = 'idle' | 'acquiring' | 'preview' | 'connecting' | 'live' | 'stopping';

const BITRATES = [1500, 2500, 4000, 6000, 8000, 12000];

const LIMIT_REASONS: Record<string, string> = {
  bandwidth: 'качество снижено: не хватает пропускной способности',
  cpu: 'качество снижено: не хватает мощности процессора',
  other: 'качество снижено браузером',
};

type Media = { stream: MediaStream; release: () => void };

function mediaErrorMessage(err: unknown, source: Source): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return source === 'camera'
          ? 'Доступ к камере или микрофону запрещён. Разрешите его в настройках сайта и попробуйте снова.'
          : 'Показ экрана отменён или запрещён.';
      case 'NotFoundError':
        return 'Камера или микрофон не найдены. Проверьте подключение устройства.';
      case 'NotReadableError':
      case 'AbortError':
        return 'Устройство занято другим приложением или недоступно.';
      case 'OverconstrainedError':
        return 'Устройство не поддерживает выбранное разрешение. Выберите 720p.';
      default:
        return `Не удалось получить видео: ${err.message || err.name}`;
    }
  }
  return 'Не удалось получить видео.';
}

async function acquireMedia(source: Source, withMic: boolean, res: Resolution): Promise<Media> {
  const size = res === '1080' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  const video: MediaTrackConstraints = {
    width: { ideal: size.width },
    height: { ideal: size.height },
    frameRate: { ideal: 30 },
  };

  if (source === 'camera') {
    const stream = await navigator.mediaDevices.getUserMedia({
      video,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return { stream, release: () => stream.getTracks().forEach((t) => t.stop()) };
  }

  const display = await navigator.mediaDevices.getDisplayMedia({ video, audio: true });
  const releases: (() => void)[] = [() => display.getTracks().forEach((t) => t.stop())];
  const videoTrack = display.getVideoTracks()[0];
  if (!videoTrack) throw new DOMException('no video', 'NotFoundError');
  videoTrack.contentHint = 'detail';

  const audio: MediaStreamTrack[] = [...display.getAudioTracks()];
  if (withMic) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      releases.push(() => mic.getTracks().forEach((t) => t.stop()));
      audio.push(...mic.getAudioTracks());
    } catch {
      /* no mic permission — continue with screen audio only */
    }
  }

  let audioTrack: MediaStreamTrack | undefined = audio[0];
  if (audio.length > 1) {
    const mix = mixAudioTracks(audio);
    releases.push(mix.close);
    audioTrack = mix.track;
  }
  const stream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
  return { stream, release: () => releases.forEach((r) => r()) };
}

export function BrowserBroadcast({ whip, live }: { whip: IngestInfo['whip']; live: DashboardLive | null }) {
  const support = useMemo(() => canPublishFromBrowser(), []);
  const codecs = useMemo(() => sendableVideoCodecs(whip.codecs), [whip.codecs]);
  const ids = { codec: useId(), res: useId(), bitrate: useId(), mic: useId() };

  const [source, setSource] = useState<Source>('camera');
  const [withMic, setWithMic] = useState(true);
  const [resolution, setResolution] = useState<Resolution>(() =>
    readPref('whip.res') === '1080' ? '1080' : '720',
  );
  const [codecId, setCodecId] = useState<string>(() => {
    const saved = readPref('whip.codec');
    if (saved && codecs.some((c) => c.id === saved)) return saved;
    return (codecs.find((c) => c.id === 'H264') ?? codecs[0])?.id ?? '';
  });
  const [bitrate, setBitrate] = useState<number>(() => {
    const saved = Number(readPref('whip.bitrate'));
    return BITRATES.includes(saved) ? saved : 4000;
  });

  const [phase, setPhase] = useState<Phase>('idle');
  const [conn, setConn] = useState<RTCPeerConnectionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<OutboundStats | null>(null);
  const [hasAudio, setHasAudio] = useState(true);
  const [hasMedia, setHasMedia] = useState(false);

  const mediaRef = useRef<Media | null>(null);
  const sessionRef = useRef<WhipSession | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const cancelledRef = useRef(false);

  const attachPreview = (stream: MediaStream | null) => {
    const v = previewRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  };

  const releaseMedia = useCallback(() => {
    mediaRef.current?.release();
    mediaRef.current = null;
    setHasMedia(false);
    attachPreview(null);
  }, []);

  const stopAll = useCallback(
    async (opts: { keepMedia?: boolean; keepalive?: boolean } = {}) => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        setPhase('stopping');
        await session.stop({ keepalive: opts.keepalive ?? false });
      }
      setConn(null);
      setStats(null);
      if (opts.keepMedia && mediaRef.current) {
        setPhase('preview');
      } else {
        releaseMedia();
        setPhase('idle');
      }
    },
    [releaseMedia],
  );

  const ensureMedia = async (): Promise<Media | null> => {
    if (mediaRef.current) return mediaRef.current;
    setPhase('acquiring');
    try {
      const media = await acquireMedia(source, withMic, resolution);
      mediaRef.current = media;
      setHasMedia(true);
      setHasAudio(media.stream.getAudioTracks().length > 0);
      attachPreview(media.stream);
      // Browser's own "stop sharing" button or unplugged camera ends the broadcast.
      media.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        void stopAll();
      });
      return media;
    } catch (err) {
      setError(mediaErrorMessage(err, source));
      setPhase('idle');
      return null;
    }
  };

  const onPreview = async () => {
    setError(null);
    const media = await ensureMedia();
    if (media) setPhase('preview');
  };

  const onStart = async () => {
    setError(null);
    const codec = codecs.find((c) => c.id === codecId);
    if (!codec) {
      setError('Выберите кодек видео.');
      return;
    }
    const media = await ensureMedia();
    if (!media) return;
    cancelledRef.current = false;
    setPhase('connecting');
    setConn('new');
    try {
      const session = await WhipSession.start({
        url: whip.url,
        stream: media.stream,
        videoMimeType: codec.mimeType,
        maxBitrateKbps: bitrate,
        onConnectionState: (s) => {
          setConn(s);
          if (s === 'connected') setPhase('live');
          if (s === 'failed') {
            setError('Соединение с сервером потеряно. Проверьте сеть и начните эфир снова.');
            void stopAll({ keepMedia: true });
          }
        },
      });
      if (cancelledRef.current) {
        await session.stop();
        return;
      }
      sessionRef.current = session;
      if (session.pc.connectionState === 'connected') setPhase('live');
    } catch (err) {
      setError(err instanceof WhipError ? err.message : 'Не удалось начать эфир.');
      setConn(null);
      setPhase(mediaRef.current ? 'preview' : 'idle');
    }
  };

  const onCancelConnect = () => {
    cancelledRef.current = true;
    void stopAll({ keepMedia: true });
  };

  // Changing the source invalidates the current preview.
  const changeSource = (s: Source) => {
    setSource(s);
    if (phase === 'preview') {
      releaseMedia();
      setPhase('idle');
    }
  };

  const changeBitrate = (kbps: number) => {
    setBitrate(kbps);
    writePref('whip.bitrate', String(kbps));
    void sessionRef.current?.setMaxBitrate(kbps);
  };

  // Outbound stats while publishing.
  useEffect(() => {
    if (phase !== 'live') return;
    const id = window.setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      s.stats().then(setStats, () => undefined);
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  // Leaving the page ends the WHIP session cleanly.
  useEffect(() => {
    const onHide = () => {
      void sessionRef.current?.stop({ keepalive: true });
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      void sessionRef.current?.stop({ keepalive: true });
      sessionRef.current = null;
      mediaRef.current?.release();
      mediaRef.current = null;
    };
  }, []);

  // Warn before closing the tab mid-broadcast.
  useEffect(() => {
    if (phase !== 'live' && phase !== 'connecting') return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [phase]);

  const busy = phase === 'acquiring' || phase === 'connecting' || phase === 'stopping';
  const publishing = phase === 'live' || phase === 'connecting';
  // Channel already on air from somewhere else (OBS etc.).
  const occupied = live !== null && !publishing && phase !== 'stopping';
  const occupiedBy = occupied && live ? protocolLabel(live.source.protocol) : null;

  const connLabel =
    phase === 'connecting'
      ? 'Подключаемся к серверу…'
      : phase === 'live'
        ? conn === 'disconnected'
          ? 'Связь прерывается, пробуем восстановить…'
          : 'Видео уходит на сервер'
        : phase === 'preview'
          ? 'Предпросмотр, в эфир не идёт'
          : phase === 'acquiring'
            ? 'Ждём разрешения браузера…'
            : null;

  return (
    <section className="panel bb" aria-labelledby="bb-h" data-phase={phase}>
      <div className="panel__head">
        <div>
          <h2 className="h-section" id="bb-h">
            Эфир из браузера
          </h2>
          <p className="panel__lede">Без OBS: камера или экран прямо из этой вкладки по WebRTC (WHIP).</p>
        </div>
      </div>

      {!support.ok ? (
        <div className="notice notice--warn">
          <TriangleAlert aria-hidden="true" />
          <div className="notice__body">{support.reason}</div>
        </div>
      ) : codecs.length === 0 ? (
        <div className="notice notice--warn">
          <TriangleAlert aria-hidden="true" />
          <div className="notice__body">
            Этот браузер не умеет отправлять ни один из кодеков, которые принимает сервер (
            {whip.codecs.map(codecLabel).join(', ')}).
          </div>
        </div>
      ) : (
        <div className="bb__grid">
          <div className="bb__monitor" data-phase={phase}>
            <video ref={previewRef} className="bb__video" muted playsInline autoPlay aria-label="Предпросмотр" />
            {!hasMedia && phase !== 'acquiring' ? (
              <div className="bb__placeholder">
                <Video aria-hidden="true" />
                <span>Здесь появится картинка, которую увидят зрители</span>
              </div>
            ) : null}
            {phase === 'live' ? (
              <span className="bb__onair status status--live">
                <span className="status__dot" aria-hidden="true" />
                Отправляем
              </span>
            ) : null}
          </div>

          <div className="bb__controls">
            <fieldset className="bb__source" disabled={publishing || busy}>
              <legend className="field__label">Источник</legend>
              <div className="segmented">
                <label className="segmented__item">
                  <input
                    type="radio"
                    name="bb-source"
                    checked={source === 'camera'}
                    onChange={() => changeSource('camera')}
                  />
                  <Camera aria-hidden="true" />
                  Камера и микрофон
                </label>
                <label className="segmented__item">
                  <input
                    type="radio"
                    name="bb-source"
                    checked={source === 'screen'}
                    onChange={() => changeSource('screen')}
                  />
                  <Monitor aria-hidden="true" />
                  Экран
                </label>
              </div>
              {source === 'screen' ? (
                <label className="checkbox" htmlFor={ids.mic}>
                  <input
                    id={ids.mic}
                    type="checkbox"
                    checked={withMic}
                    onChange={(e) => {
                      setWithMic(e.target.checked);
                      if (phase === 'preview') {
                        releaseMedia();
                        setPhase('idle');
                      }
                    }}
                  />
                  Добавить микрофон
                </label>
              ) : null}
            </fieldset>

            <div className="bb__selects">
              <div className="field">
                <label className="field__label" htmlFor={ids.codec}>
                  Кодек видео
                </label>
                <select
                  id={ids.codec}
                  className="input"
                  value={codecId}
                  disabled={publishing || busy}
                  onChange={(e) => {
                    setCodecId(e.target.value);
                    writePref('whip.codec', e.target.value);
                  }}
                >
                  {codecs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor={ids.res}>
                  Разрешение
                </label>
                <select
                  id={ids.res}
                  className="input"
                  value={resolution}
                  disabled={publishing || busy}
                  onChange={(e) => {
                    const r = e.target.value === '1080' ? '1080' : '720';
                    setResolution(r);
                    writePref('whip.res', r);
                    if (phase === 'preview') {
                      releaseMedia();
                      setPhase('idle');
                    }
                  }}
                >
                  <option value="720">720p</option>
                  <option value="1080">1080p</option>
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor={ids.bitrate}>
                  Битрейт до
                </label>
                <select
                  id={ids.bitrate}
                  className="input"
                  value={bitrate}
                  disabled={busy}
                  onChange={(e) => changeBitrate(Number(e.target.value))}
                >
                  {BITRATES.map((b) => (
                    <option key={b} value={b}>
                      {formatKbps(b)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="field__hint">
              Кодеки в списке — те, что умеет отправлять этот браузер. Битрейт можно менять прямо во время эфира.
            </p>

            {occupied ? (
              <div className="notice notice--warn">
                <TriangleAlert aria-hidden="true" />
                <div className="notice__body">
                  Канал уже в эфире{occupiedBy ? ` через ${occupiedBy}` : ''}. Сервер может отклонить второе
                  подключение: сначала остановите текущую трансляцию.
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="notice notice--error" role="alert">
                <TriangleAlert aria-hidden="true" />
                <div className="notice__body">{error}</div>
              </div>
            ) : null}

            <div className="bb__actions">
              {phase === 'live' || phase === 'stopping' ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void stopAll()}
                  disabled={phase === 'stopping'}
                >
                  <Square aria-hidden="true" />
                  Завершить эфир
                </button>
              ) : phase === 'connecting' ? (
                <>
                  <button type="button" className="btn btn--onair" disabled>
                    <span className="spinner spinner--sm" aria-hidden="true" />
                    Подключение…
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={onCancelConnect}>
                    Отменить
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn--onair"
                    onClick={() => void onStart()}
                    disabled={busy || !codecId}
                  >
                    <span className="btn__dot" aria-hidden="true" />
                    Начать эфир
                  </button>
                  {phase === 'preview' ? (
                    <button type="button" className="btn btn--outline" onClick={() => void stopAll()}>
                      Выключить предпросмотр
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--outline"
                      onClick={() => void onPreview()}
                      disabled={busy}
                    >
                      {phase === 'acquiring' ? (
                        <span className="spinner spinner--sm" aria-hidden="true" />
                      ) : null}
                      Предпросмотр
                    </button>
                  )}
                </>
              )}
            </div>

            <p className="bb__conn" role="status" aria-live="polite" data-conn={conn ?? 'none'}>
              {connLabel ? (
                <>
                  <span className="bb__lamp" aria-hidden="true" />
                  {connLabel}
                </>
              ) : null}
            </p>

            {phase === 'live' && stats ? (
              <dl className="bb__stats">
                <div>
                  <dt>Кодек</dt>
                  <dd>{stats.codec ? codecLabel(stats.codec) : '—'}</dd>
                </div>
                <div>
                  <dt>Кадр</dt>
                  <dd className="num">{stats.width && stats.height ? `${stats.width}×${stats.height}` : '—'}</dd>
                </div>
                <div>
                  <dt>Частота</dt>
                  <dd className="num">{formatFps(stats.fps) ?? '—'}</dd>
                </div>
                <div>
                  <dt>Отправляем</dt>
                  <dd className="num">{formatKbps(stats.kbps) ?? '—'}</dd>
                </div>
                {stats.limitedBy ? (
                  <div className="bb__stats-wide">
                    <dt>Внимание</dt>
                    <dd>{LIMIT_REASONS[stats.limitedBy] ?? stats.limitedBy}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            {!hasAudio && hasMedia ? (
              <p className="field__hint">Звука нет: браузер не передал звук экрана, а микрофон не добавлен.</p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
