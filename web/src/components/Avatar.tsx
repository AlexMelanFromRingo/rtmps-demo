import { useState } from 'react';
import type { ChannelPublic } from '../api/types';
import { Monogram } from './Monogram';

type Props = {
  channel: Pick<ChannelPublic, 'slug' | 'displayName' | 'avatarUrl'>;
  size?: number;
  /** Draws the tally ring: the channel is on air. */
  live?: boolean;
};

/** Channel avatar; falls back to the monogram when there is no image or it fails to load. */
export function Avatar({ channel, size = 40, live = false }: Props) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = channel.avatarUrl;
  const showImage = url && failed !== url;
  return (
    <span className={`avatar${live ? ' avatar--live' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      {showImage ? (
        <img
          className="avatar__img"
          src={url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(url)}
        />
      ) : (
        <Monogram name={channel.displayName} seed={channel.slug} size={size} />
      )}
    </span>
  );
}
