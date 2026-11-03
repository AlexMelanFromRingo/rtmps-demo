import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { HealthSample, RecentBroadcast } from '../../api/types';
import { ErrorNotice } from '../../components/EmptyState';
import { ChartTable, LineChart, type Point } from '../../components/LineChart';
import {
  formatCount,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatKbps,
  formatTime,
  plural,
  viewersWord,
} from '../../lib/format';
import { useDocumentVisible, useResource } from '../../lib/hooks';

const REFRESH_MS = 10_000;
const DEFAULT = '';

type Stats = { last: number | null; min: number; max: number; avg: number; maxAt: number; count: number };

function statsOf(points: Point[]): Stats | null {
  const vals = points.filter((p): p is { t: number; v: number } => p.v != null && Number.isFinite(p.v));
  if (!vals.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let maxAt = vals[0]!.t;
  let sum = 0;
  for (const p of vals) {
    min = Math.min(min, p.v);
    if (p.v > max) {
      max = p.v;
      maxAt = p.t;
    }
    sum += p.v;
  }
  const lastPoint = points[points.length - 1];
  return { last: lastPoint?.v ?? null, min, max, avg: sum / vals.length, maxAt, count: vals.length };
}

/** Mbit/s axis when the stream is ≥ 1 Mbit/s, else kbit/s. */
function kbpsAxis(max: number) {
  if (max >= 1000) {
    return { unit: 'Мбит/с', tick: (v: number) => formatDecimal(v / 1000, v % 1000 === 0 ? 0 : 1) };
  }
  return { unit: 'кбит/с', tick: (v: number) => formatCount(Math.round(v)) };
}

export function HealthPanel({ isLive, recent }: { isLive: boolean; recent: RecentBroadcast[] }) {
  const selectId = useId();
  const [broadcast, setBroadcast] = useState<string>(DEFAULT);
  const res = useResource((signal) => api.health(broadcast || undefined, signal), `health:${broadcast}`);
  const visible = useDocumentVisible();
  const following = broadcast === DEFAULT && isLive;
  const { reload } = res;

  // While live (and watching the current broadcast), refresh every 10 s.
  useEffect(() => {
    if (!following || !visible) return;
    const id = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [following, visible, reload]);

  // Going live / ending a broadcast: refetch so the default view switches broadcasts.
  const prevLive = useRef(isLive);
  useEffect(() => {
    if (prevLive.current === isLive) return;
    prevLive.current = isLive;
    if (broadcast === DEFAULT) reload();
  }, [isLive, broadcast, reload]);

  const samples: HealthSample[] = res.data?.samples ?? [];
  const bitrate = useMemo<Point[]>(
    () => samples.map((s) => ({ t: Date.parse(s.ts), v: s.ingestKbps })).filter((p) => Number.isFinite(p.t)),
    [samples],
  );
  const viewers = useMemo<Point[]>(
    () => samples.map((s) => ({ t: Date.parse(s.ts), v: s.viewers })).filter((p) => Number.isFinite(p.t)),
    [samples],
  );
  const b = statsOf(bitrate);
  const v = statsOf(viewers);
  const axis = kbpsAxis(b?.max ?? 0);
  const span = bitrate.length > 1 ? bitrate[bitrate.length - 1]!.t - bitrate[0]!.t : 0;
  const gaps = bitrate.filter((p) => p.v == null).length;

  const bitrateSummary = b
    ? `${following && b.last != null ? `Сейчас ${formatKbps(b.last)}, в` : 'В'} среднем ${formatKbps(b.avg)}, от ${formatKbps(b.min)} до ${formatKbps(b.max)}${gaps ? `; без сигнала: ${gaps} ${plural(gaps, 'отметка', 'отметки', 'отметок')} по 10 с` : ''}.`
    : 'Данных о битрейте нет.';
  const viewersSummary = v
    ? `${following && v.last != null ? `Сейчас ${formatCount(v.last)}, п` : 'П'}ик ${formatCount(v.max)} ${viewersWord(v.max)} в ${formatTime(v.maxAt)}.`
    : 'Данных о зрителях нет.';

  const options = recent.filter((r) => r.endedAt);

  return (
    <section className="panel health" id="health" aria-labelledby="health-h">
      <div className="panel__head">
        <div>
          <h2 className="h-section" id="health-h">
            Здоровье эфира
          </h2>
          <p className="panel__lede">
            Битрейт, который доходит до сервера, и число зрителей — отметки каждые 10 секунд
            {span > 0 ? `, за ${formatDuration(span)}` : ''}.
          </p>
        </div>
        <div className="health__pick">
          <label className="visually-hidden" htmlFor={selectId}>
            Эфир
          </label>
          <select
            id={selectId}
            className="input input--sm"
            value={broadcast}
            onChange={(e) => setBroadcast(e.target.value)}
          >
            <option value={DEFAULT}>{isLive ? 'Текущий эфир' : 'Последний эфир'}</option>
            {options.map((r) => (
              <option key={r.id} value={r.id}>
                {formatDateTime(r.startedAt)}
                {r.title ? ` — ${r.title.slice(0, 40)}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {res.error && !res.data ? (
        <ErrorNotice title="Графики не загрузились" message={errorMessage(res.error)} onRetry={reload} />
      ) : !res.data ? (
        <div className="health__charts" aria-busy="true">
          <div className="skeleton" style={{ height: 230 }} />
          <div className="skeleton" style={{ height: 230 }} />
        </div>
      ) : samples.length === 0 ? (
        <p className="muted health__empty">
          {isLive
            ? 'Первые отметки появятся через несколько секунд после начала эфира.'
            : 'Здесь появятся графики, когда вы проведёте первый эфир.'}
        </p>
      ) : (
        <>
          <div className="health__charts">
            <LineChart
              title="Входной битрейт"
              points={bitrate}
              format={(x) => formatKbps(x) ?? '—'}
              tick={axis.tick}
              unit={axis.unit}
              summary={bitrateSummary}
            />
            <LineChart
              title="Зрители"
              points={viewers}
              format={(x) => `${formatCount(x)} ${viewersWord(x)}`}
              tick={(x) => formatCount(x)}
              unit="чел."
              summary={viewersSummary}
              integer
            />
          </div>
          <ChartTable
            caption="Битрейт и зрители по времени"
            columns={['Битрейт', 'Зрители']}
            rows={samples
              .map((s) => ({
                t: Date.parse(s.ts),
                values: [s.ingestKbps != null ? (formatKbps(s.ingestKbps) ?? null) : null, formatCount(s.viewers)],
              }))
              .filter((r) => Number.isFinite(r.t))}
          />
        </>
      )}
    </section>
  );
}
