import type { Rendition } from '../api/types';
import { codecLabel, formatKbps } from '../lib/format';

/** Rendition list drawn as a ladder: bar length ∝ bitrate. */
export function RenditionLadder({ renditions }: { renditions: Rendition[] }) {
  if (renditions.length === 0) return null;
  const sorted = [...renditions].sort((a, b) => b.height - a.height || b.bitrateKbps - a.bitrateKbps);
  const max = Math.max(...sorted.map((r) => r.bitrateKbps), 1);
  return (
    <ul className="ladder">
      {sorted.map((r) => (
        <li key={r.name} className="ladder__row" data-source={r.passthrough ? 'true' : 'false'}>
          <div className="ladder__name">
            <span className="ladder__label">{r.label}</span>
            <span className="ladder__spec num">
              {r.width}×{r.height}, {Math.round(r.fps)} fps
            </span>
          </div>
          <span className="chip ladder__codec">{codecLabel(r.codec)}</span>
          <div className="ladder__bar" aria-hidden="true">
            <span style={{ width: `${Math.max(4, (r.bitrateKbps / max) * 100)}%` }} />
          </div>
          <span className="ladder__rate num">{formatKbps(r.bitrateKbps)}</span>
        </li>
      ))}
    </ul>
  );
}
