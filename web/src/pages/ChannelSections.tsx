import { ExternalLink, Pencil } from 'lucide-react';
import { Link } from 'react-router';
import { api, errorMessage } from '../api/client';
import type { ChannelPublic } from '../api/types';
import { EmptyState, ErrorNotice } from '../components/EmptyState';
import { VideoTile } from '../components/VideoTile';
import { formatDate } from '../lib/format';
import { useResource } from '../lib/hooks';

const HTTPS_RE = /^https:\/\//i;

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "О канале": bio, links, follower count. */
export function ChannelAbout({ channel, own }: { channel: ChannelPublic; own: boolean }) {
  const links = (channel.links ?? []).filter((l) => HTTPS_RE.test(l.url));
  const bio = channel.bio?.trim() ?? '';
  return (
    <section className="panel about" aria-labelledby="about-h">
      <h2 className="h-section" id="about-h">
        О канале
      </h2>
      {bio ? <p className="about__bio">{bio}</p> : null}
      {links.length ? (
        <ul className="about__links">
          {links.map((l) => (
            <li key={`${l.label}|${l.url}`}>
              <a className="about__link" href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc">
                <ExternalLink aria-hidden="true" />
                <span className="about__link-label">{l.label || hostOf(l.url)}</span>
                <span className="about__link-host">{hostOf(l.url)}</span>
                <span className="visually-hidden">(откроется в новой вкладке)</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {!bio && !links.length ? (
        <p className="muted about__empty">
          {own ? 'Расскажите зрителям о себе и добавьте ссылки на соцсети.' : 'Стример пока ничего о себе не рассказал.'}
        </p>
      ) : null}
      {own ? (
        <Link to="/dashboard#profile" className="btn btn--outline btn--sm about__edit">
          <Pencil aria-hidden="true" />
          Изменить в студии
        </Link>
      ) : null}
    </section>
  );
}

/** "Видео" tab: past broadcasts. */
export function ChannelVideos({ slug, own }: { slug: string; own: boolean }) {
  const res = useResource((signal) => api.channelVideos(slug, signal), slug);
  const videos = res.data?.videos ?? null;

  if (videos === null && res.error) {
    return <ErrorNotice title="Записи не загрузились" message={errorMessage(res.error)} onRetry={res.reload} />;
  }
  if (videos === null) {
    return (
      <ul className="grid" aria-busy="true" aria-label="Загружаем записи">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} aria-hidden="true">
            <div className="tile-skeleton">
              <div className="skeleton tile-skeleton__screen" />
              <div className="skeleton tile-skeleton__line" />
              <div className="skeleton tile-skeleton__line tile-skeleton__line--short" />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (videos.length === 0) {
    return (
      <EmptyState title="Записей пока нет">
        {own ? (
          <p>
            Каждый эфир сохраняется как видео с перемоткой, если в студии включено «Сохранять записи эфиров».
          </p>
        ) : (
          <p>Прошедшие эфиры появятся здесь после окончания трансляции.</p>
        )}
      </EmptyState>
    );
  }
  const soonest = videos.reduce((min, v) => (v.expiresAt < min ? v.expiresAt : min), videos[0]!.expiresAt);
  return (
    <div className="channel__videos">
      <p className="muted channel__retention">
        Записи хранятся ограниченное время: ближайшая будет удалена {formatDate(soonest)}.
      </p>
      <ul className="grid">
        {videos.map((v) => (
          <li key={v.id}>
            <VideoTile video={v} />
          </li>
        ))}
      </ul>
    </div>
  );
}
