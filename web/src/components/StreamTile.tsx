import { Eye, MonitorPlay } from 'lucide-react';
import { Link } from 'react-router';
import type { StreamCard } from '../api/types';
import {
  formatCount,
  formatDuration,
  protocolLabel,
  sinceMs,
  sourceBadge,
  viewersWord,
  withCacheBust,
} from '../lib/format';
import { Avatar } from './Avatar';
import { StatusBadge, broadcastState } from './StatusBadge';
import { Thumb } from './Thumb';

type Props = {
  stream: StreamCard;
  /** Cache-buster for the thumbnail, bumped by the directory every ~15 s. */
  thumbTick: number;
  now: number;
  featured?: boolean;
};

export function StreamTile({ stream, thumbTick, now, featured = false }: Props) {
  const { channel, live } = stream;
  const state = broadcastState(live);
  const badge = sourceBadge(live.source);
  const protocol = protocolLabel(live.source.protocol);
  const thumb = live.thumbnailUrl ? withCacheBust(live.thumbnailUrl, thumbTick) : null;
  const title = channel.title.trim() || `Эфир ${channel.displayName}`;

  return (
    <article className={`tile${featured ? ' tile--featured' : ''}`} data-state={state}>
      <div className="tile__screen">
        <Thumb
          src={thumb}
          className="tile__img"
          fallback={
            <div className="tile__noimg" aria-hidden="true">
              {state === 'starting' ? <div className="spinner" /> : <MonitorPlay />}
            </div>
          }
        />
        <div className="tile__top">
          <StatusBadge state={state} />
          {channel.mature ? (
            <span className="tile__pill tile__mature" title="Контент для взрослых">
              18+
            </span>
          ) : null}
        </div>
        <div className="tile__bottom">
          <span className="tile__pill num" aria-label={`${formatCount(live.viewers)} ${viewersWord(live.viewers)}`}>
            <Eye aria-hidden="true" />
            {formatCount(live.viewers)}
          </span>
          <span className="tile__pill tile__uptime num" title="В эфире">
            {formatDuration(sinceMs(live.startedAt, now))}
          </span>
        </div>
      </div>
      <div className="tile__umd">
        <Avatar channel={channel} size={featured ? 44 : 36} />
        <div className="tile__meta">
          <h3 className="tile__title">
            <Link to={`/${channel.slug}`} className="tile__link">
              {title}
            </Link>
          </h3>
          <p className="tile__channel">{channel.displayName}</p>
          {channel.category ? <p className="tile__category">{channel.category}</p> : null}
        </div>
      </div>
      {badge || protocol ? (
        <div className="tile__tech">
          {badge ? <span className="chip num">{badge}</span> : null}
          {protocol ? <span className="chip chip--key">{protocol}</span> : null}
        </div>
      ) : null}
    </article>
  );
}
