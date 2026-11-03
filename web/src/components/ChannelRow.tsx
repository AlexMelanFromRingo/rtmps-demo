import { Link } from 'react-router';
import type { ChannelWithLive } from '../api/types';
import { followersLabel, viewersLabel } from '../lib/format';
import { Avatar } from './Avatar';
import { StatusBadge, broadcastState } from './StatusBadge';

/** A channel as a list row (search results, offline follows). The whole row is the link. */
export function ChannelRow({ entry }: { entry: ChannelWithLive }) {
  const { channel, live } = entry;
  const state = broadcastState(live);
  return (
    <li className="crow" data-state={state}>
      <Avatar channel={channel} size={48} live={state === 'live'} />
      <div className="crow__text">
        <Link to={`/${channel.slug}`} className="crow__link">
          {channel.displayName}
        </Link>
        <span className="crow__sub">
          {live && channel.title ? channel.title : channel.category || `@${channel.slug}`}
        </span>
        <span className="crow__meta num">{followersLabel(channel.followers ?? 0)}</span>
      </div>
      <div className="crow__side">
        {live ? (
          <>
            <StatusBadge state={state} />
            <span className="crow__viewers num">{viewersLabel(live.viewers)}</span>
          </>
        ) : (
          <span className="crow__off">не в эфире</span>
        )}
      </div>
    </li>
  );
}
