import { Film } from 'lucide-react';
import { Link } from 'react-router';
import type { Video } from '../api/types';
import { formatClock, formatRelativeDay, spokenClock, viewsLabel } from '../lib/format';
import { Avatar } from './Avatar';
import { Thumb } from './Thumb';

/** A past broadcast in a grid: monitor with timecode badge + title, date, views. */
export function VideoTile({ video, showChannel = false }: { video: Video; showChannel?: boolean }) {
  const title = video.title.trim() || `Эфир ${formatRelativeDay(video.startedAt)}`;
  return (
    <article className="tile tile--vod">
      <div className="tile__screen">
        <Thumb
          src={video.thumbnailUrl}
          className="tile__img"
          fallback={
            <div className="tile__noimg" aria-hidden="true">
              <Film />
            </div>
          }
        />
        <div className="tile__bottom tile__bottom--end">
          <span className="tile__pill num" aria-label={`Длительность ${spokenClock(video.durationSec)}`}>
            {formatClock(video.durationSec)}
          </span>
        </div>
      </div>
      <div className="tile__umd">
        {showChannel ? <Avatar channel={video.channel} size={36} /> : null}
        <div className="tile__meta">
          <h3 className="tile__title">
            <Link to={`/videos/${encodeURIComponent(video.id)}`} className="tile__link">
              {title}
            </Link>
          </h3>
          {showChannel ? <p className="tile__channel">{video.channel.displayName}</p> : null}
          <p className="tile__category">
            <time dateTime={video.startedAt}>{formatRelativeDay(video.startedAt)}</time>
            <span className="tile__sep" aria-hidden="true" />
            <span className="num">{viewsLabel(video.views)}</span>
          </p>
        </div>
      </div>
    </article>
  );
}
