import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatTime } from '../lib/format';

export type Point = { t: number; v: number | null };

type Props = {
  title: string;
  points: Point[];
  /** Formats a value for the tooltip / table ("5,8 Мбит/с"). */
  format: (v: number) => string;
  /** Formats an axis tick (shorter: "6"). */
  tick: (v: number) => string;
  /** Axis unit caption, e.g. "Мбит/с". */
  unit: string;
  /** Visible plain-language summary (also the accessible description). */
  summary: string;
  height?: number;
  integer?: boolean;
};

const M = { top: 24, right: 12, bottom: 26, left: 44 };

/** 1-2-5 "nice" step for ~`count` ticks up to `max`. */
function niceTicks(max: number, count: number, integer: boolean): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step0 = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const step = integer ? Math.max(1, Math.ceil(step0)) : step0;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks.length < 2) ticks.push(step);
  return ticks;
}

/** Evenly spaced time ticks, rounded to whole minutes. */
function timeTicks(t0: number, t1: number, count: number): number[] {
  if (t1 <= t0) return [t0];
  const span = t1 - t0;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240].map((m) => m * 60_000);
  const step = steps.find((s) => span / s <= count) ?? steps[steps.length - 1]!;
  const first = Math.ceil(t0 / step) * step;
  const out: number[] = [];
  for (let t = first; t <= t1; t += step) out.push(t);
  return out;
}

/**
 * Single-series line chart in inline SVG: recessive grid, 2 px line, gaps for missing samples,
 * crosshair tooltip on hover/keyboard, and a table fallback.
 */
export function LineChart({ title, points, format, tick, unit, summary, height = 196, integer = false }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);
  const ids = { title: useId(), desc: useId() };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    const valid = points.filter((p): p is { t: number; v: number } => p.v != null && Number.isFinite(p.v));
    const t0 = points[0]?.t ?? 0;
    const t1 = points[points.length - 1]?.t ?? 1;
    const maxV = valid.reduce((m, p) => Math.max(m, p.v), 0);
    const yTicks = niceTicks(maxV * 1.08, 4, integer);
    const yMax = yTicks[yTicks.length - 1] || 1;
    const iw = width - M.left - M.right;
    const ih = height - M.top - M.bottom;
    const x = (t: number) => M.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * iw : iw / 2);
    const y = (v: number) => M.top + ih - (v / yMax) * ih;

    // Split into runs at missing samples so gaps stay visible.
    let line = '';
    let area = '';
    let run: { t: number; v: number }[] = [];
    const flush = () => {
      if (!run.length) return;
      const pts = run.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
      line += `M${pts.join('L')}`;
      if (run.length > 1) {
        area += `M${x(run[0]!.t).toFixed(1)},${y(0)}L${pts.join('L')}L${x(run[run.length - 1]!.t).toFixed(1)},${y(0)}Z`;
      }
      run = [];
    };
    for (const p of points) {
      if (p.v == null || !Number.isFinite(p.v)) flush();
      else run.push({ t: p.t, v: p.v });
    }
    flush();
    const xTicks = timeTicks(t0, t1, Math.max(2, Math.floor(iw / 90)));
    return { x, y, line, area, yTicks, xTicks, iw, ih, t0, t1, hasData: valid.length > 0 };
  }, [points, width, height, integer]);

  const pickAt = (clientX: number) => {
    const el = wrapRef.current;
    if (!el || points.length === 0) return;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geo.x(p.t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => pickAt(e.clientX);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!points.length) return;
    const last = points.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = hover == null ? last : Math.min(last, hover + 1);
    else if (e.key === 'ArrowLeft') next = hover == null ? last : Math.max(0, hover - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape') {
      setHover(null);
      return;
    } else return;
    e.preventDefault();
    setHover(next);
  };

  const hp = hover != null ? points[hover] : undefined;
  const hx = hp ? geo.x(hp.t) : 0;
  const tipLeft = Math.min(Math.max(hx, 70), width - 70);

  return (
    <figure className="lchart" aria-labelledby={ids.title}>
      <figcaption className="lchart__cap">
        <span className="lchart__title" id={ids.title}>
          {title}
        </span>
        <span className="lchart__summary" id={ids.desc}>
          {summary}
        </span>
      </figcaption>
      <div
        ref={wrapRef}
        className="lchart__plot"
        style={{ height }}
        tabIndex={geo.hasData ? 0 : -1}
        role="img"
        aria-labelledby={ids.title}
        aria-describedby={ids.desc}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg width={width} height={height} aria-hidden="true">
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line
                className={v === 0 ? 'lchart__base' : 'lchart__grid'}
                x1={M.left}
                x2={width - M.right}
                y1={geo.y(v)}
                y2={geo.y(v)}
              />
              <text className="lchart__tick" x={M.left - 8} y={geo.y(v)} dy="0.32em" textAnchor="end">
                {tick(v)}
              </text>
            </g>
          ))}
          <text className="lchart__unit" x={0} y={10}>
            {unit}
          </text>
          {geo.xTicks.map((t) => (
            <text key={t} className="lchart__tick" x={geo.x(t)} y={height - 8} textAnchor="middle">
              {formatTime(t)}
            </text>
          ))}
          {geo.hasData ? (
            <>
              <path className="lchart__area" d={geo.area} />
              <path className="lchart__line" d={geo.line} />
            </>
          ) : null}
          {hp ? (
            <>
              <line className="lchart__cross" x1={hx} x2={hx} y1={M.top} y2={M.top + geo.ih} />
              {hp.v != null ? <circle className="lchart__dot" cx={hx} cy={geo.y(hp.v)} r={4.5} /> : null}
            </>
          ) : null}
        </svg>
        {!geo.hasData ? <p className="lchart__empty">Нет данных за этот период.</p> : null}
        {hp ? (
          <div className="lchart__tip" style={{ left: tipLeft }} aria-hidden="true">
            <span className="lchart__tip-v num">{hp.v != null ? format(hp.v) : 'нет данных'}</span>
            <span className="lchart__tip-t num">{formatTime(hp.t)}</span>
          </div>
        ) : null}
      </div>
      <span className="visually-hidden" aria-live="polite">
        {hp ? `${formatTime(hp.t)}: ${hp.v != null ? format(hp.v) : 'нет данных'}` : ''}
      </span>
    </figure>
  );
}

/** The same series as a table (for screen readers, print, or exact values). */
export function ChartTable({
  caption,
  rows,
  columns,
}: {
  caption: string;
  rows: { t: number; values: (string | null)[] }[];
  columns: string[];
}) {
  return (
    <details className="lchart__details">
      <summary>Показать значения таблицей</summary>
      <div className="lchart__table-wrap">
        <table className="lchart__table">
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Время</th>
              {columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.t}>
                <th scope="row" className="num">
                  {formatTime(r.t)}
                </th>
                {r.values.map((v, i) => (
                  <td key={i} className="num">
                    {v ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
