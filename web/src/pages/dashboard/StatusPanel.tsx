import { Cpu, Radio, Server, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChannelPrivate, DashboardLive } from '../../api/types';
import { Player } from '../../components/Player';
import { StatusBadge, broadcastState } from '../../components/StatusBadge';
import {
  codecLabel,
  formatCount,
  formatDecimal,
  formatFps,
  formatKbps,
  formatUptime,
  plural,
  protocolLabel,
  sinceMs,
  viewersWord,
} from '../../lib/format';
import { useNow } from '../../lib/hooks';

type Lamp = 'ok' | 'standby' | 'off' | 'warn';

type Stage = {
  key: string;
  icon: ReactNode;
  name: string;
  lamp: Lamp;
  value: ReactNode;
  details: { k: string; v: string | null }[];
};

export function StatusPanel({ live, channel }: { live: DashboardLive | null; channel: ChannelPrivate }) {
  const state = broadcastState(live);
  const now = useNow(1000, live !== null);
  const stages = buildChain(live, channel);

  return (
    <section className="panel statuspanel" data-state={state} aria-labelledby="status-h">
      <div className="statuspanel__head">
        <h2 className="visually-hidden" id="status-h">
          Статус эфира
        </h2>
        <StatusBadge state={state} size="lg" />
        {live ? (
          <p className="statuspanel__uptime">
            <span className="statuspanel__clock num">{formatUptime(sinceMs(live.startedAt, now))}</span>
            <span className="muted">в эфире</span>
          </p>
        ) : null}
        <p className="visually-hidden" role="status" aria-live="polite">
          {state === 'live'
            ? 'Эфир идёт'
            : state === 'starting'
              ? 'Сигнал получен, эфир запускается'
              : state === 'reconnecting'
                ? 'Сигнал пропал, ждём переподключения'
                : 'Нет сигнала'}
        </p>
      </div>

      <div className="statuspanel__body">
        <div className="statuspanel__monitor">
          {live?.playbackUrl ? (
            <Player
              key={live.broadcastId}
              src={live.playbackUrl}
              renditions={live.renditions}
              live={live.status === 'live'}
              poster={live.thumbnailUrl}
              preview
              label="Предпросмотр вашего эфира"
              overlay={
                live.status === 'reconnecting' ? (
                  <div className="reconnect-chip" role="status">
                    <span className="status__dot" aria-hidden="true" />
                    Сигнал пропал — ждём переподключения
                  </div>
                ) : undefined
              }
            />
          ) : (
            <div className="monitor-empty" data-state={state}>
              {live ? (
                <>
                  <div className="spinner" aria-hidden="true" />
                  <strong>Сигнал получен</strong>
                  <span>Готовим первые сегменты видео…</span>
                </>
              ) : (
                <>
                  <strong>Нет сигнала</strong>
                  <span>
                    Запустите трансляцию в OBS или из браузера ниже. Статус обновится сам, страницу
                    перезагружать не нужно.
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        <ol className="chain" aria-label="Путь сигнала">
          {stages.map((s) => (
            <li key={s.key} className="chain__stage" data-lamp={s.lamp}>
              <span className="chain__icon" aria-hidden="true">
                {s.icon}
              </span>
              <div className="chain__content">
                <div className="chain__top">
                  <span className="chain__name">{s.name}</span>
                  <span className="chain__value num">{s.value}</span>
                </div>
                {s.details.some((d) => d.v) ? (
                  <dl className="chain__details">
                    {s.details
                      .filter((d) => d.v)
                      .map((d) => (
                        <div key={d.k}>
                          <dt>{d.k}</dt>
                          <dd className="num">{d.v}</dd>
                        </div>
                      ))}
                  </dl>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function buildChain(live: DashboardLive | null, channel: ChannelPrivate): Stage[] {
  const mode = channel.transcodeMode === 'abr' ? 'ABR' : 'Без перекодирования';
  if (!live) {
    return [
      { key: 'src', icon: <Radio />, name: 'Источник', lamp: 'off', value: '—', details: [] },
      { key: 'ingest', icon: <Server />, name: 'Приём', lamp: 'off', value: '—', details: [] },
      {
        key: 'tx',
        icon: <Cpu />,
        name: 'Перекодирование',
        lamp: 'off',
        value: '—',
        details: [{ k: 'Режим', v: mode }],
      },
      { key: 'viewers', icon: <Users />, name: 'Зрители', lamp: 'off', value: '—', details: [] },
    ];
  }

  const src = live.source;
  const reconnecting = live.status === 'reconnecting';
  const tx = live.stats.transcoder;
  const slow = tx?.speed != null && tx.speed < 0.95;

  const srcLamp: Lamp = reconnecting ? 'standby' : 'ok';
  const txLamp: Lamp = reconnecting
    ? 'standby'
    : !tx
      ? live.playbackUrl
        ? 'ok'
        : 'standby'
      : tx.error
        ? 'warn'
        : tx.state === 'pending'
          ? 'standby'
          : slow || tx.degraded
            ? 'warn'
            : 'ok';

  const res = src.width && src.height ? `${src.width}×${src.height}` : null;

  return [
    {
      key: 'src',
      icon: <Radio />,
      name: 'Источник',
      lamp: srcLamp,
      value: reconnecting ? 'нет данных' : (formatKbps(live.stats.ingestKbps) ?? '—'),
      details: [
        { k: 'Протокол', v: protocolLabel(src.protocol) },
        { k: 'Видео', v: src.videoCodec ? codecLabel(src.videoCodec) : null },
        { k: 'Кадр', v: res },
        { k: 'Частота', v: formatFps(src.fps) },
        { k: 'Звук', v: src.audioCodec ? codecLabel(src.audioCodec) : null },
      ],
    },
    {
      key: 'ingest',
      icon: <Server />,
      name: 'Приём',
      lamp: srcLamp,
      value: live.stats.ingestNode ?? '—',
      details: [],
    },
    {
      key: 'tx',
      icon: <Cpu />,
      name: 'Перекодирование',
      lamp: txLamp,
      value: !tx
        ? channel.transcodeMode === 'passthrough'
          ? 'не нужно'
          : '—'
        : tx.error
          ? 'ошибка'
          : tx.state === 'pending'
          ? 'ждёт воркер'
          : tx.speed != null
            ? `${formatDecimal(tx.speed, 2)}×`
            : 'работает',
      details: tx
        ? [
            { k: 'Режим', v: mode },
            { k: 'Состояние', v: tx.state === 'running' ? 'работает' : tx.state === 'failed' ? 'остановлено' : 'ожидает воркер' },
            { k: 'Воркер', v: tx.worker },
            { k: 'Кодировщик', v: tx.encoder },
            { k: 'Скорость', v: tx.fps != null ? formatFps(tx.fps) : null },
            { k: 'Внимание', v: slow ? 'не успевает за реальным временем' : null },
            { k: 'Мощности', v: tx.degraded ? 'нет свободных — только исходное качество' : null },
            { k: 'Ошибка', v: tx.error ?? null },
          ]
        : [{ k: 'Режим', v: mode }],
    },
    {
      key: 'viewers',
      icon: <Users />,
      name: 'Зрители',
      lamp: live.playbackUrl ? 'ok' : 'standby',
      value: `${formatCount(live.viewers)} ${viewersWord(live.viewers)}`,
      details: [
        {
          k: 'Качества',
          v: live.renditions.length
            ? `${live.renditions.length} ${plural(live.renditions.length, 'вариант', 'варианта', 'вариантов')}`
            : null,
        },
      ],
    },
  ];
}
