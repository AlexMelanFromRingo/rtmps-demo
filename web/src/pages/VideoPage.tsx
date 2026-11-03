import { CalendarX, Radio, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, api, errorMessage } from '../api/client';
import type { Video } from '../api/types';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorNotice } from '../components/EmptyState';
import { FollowButton } from '../components/FollowButton';
import { categoryHref } from '../components/header/HeaderSearch';
import { MatureGate } from '../components/MatureGate';
import { Player } from '../components/Player';
import { VideoTile } from '../components/VideoTile';
import { useAuth } from '../lib/auth';
import { getViewerId, hasMatureConsent } from '../lib/browser';
import { followersLabel, formatDate, formatDateTime, viewsLabel } from '../lib/format';
import { useDocumentTitle, useResource } from '../lib/hooks';
import { NoSignal } from './NotFoundPage';
import './ChannelPage.css';
import './VideoPage.css';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function VideoPage() {
  const { id = '' } = useParams();
  if (!ID_RE.test(id)) return <VideoNotFound />;
  return <VideoView key={id} id={id} />;
}

function VideoNotFound() {
  useDocumentTitle('Запись не найдена');
  return (
    <NoSignal code="404" title="Такой записи нет">
      <p className="muted">Возможно, стример удалил её или истёк срок хранения записей.</p>
      <Link to="/" className="btn btn--primary">
        Открыть каталог эфиров
      </Link>
    </NoSignal>
  );
}

function VideoView({ id }: { id: string }) {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const res = useResource((signal) => api.video(id, signal), id);
  const video = res.data?.video ?? null;
  const slug = video?.channel.slug ?? '';
  // Channel info: follow state + "on air right now".
  const ch = useResource((signal) => api.channel(slug, signal), slug, slug !== '');
  const more = useResource((signal) => api.channelVideos(slug, signal, 9), `more:${slug}`, slug !== '');
  const [views, setViews] = useState<number | null>(null);
  const [consented, setConsented] = useState<boolean | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewSent = useRef(false);

  useDocumentTitle(video ? video.title || `Запись ${video.channel.displayName}` : null);

  const onWatched = useCallback(() => {
    if (viewSent.current) return;
    viewSent.current = true;
    api.videoView(id, getViewerId()).then(
      () => setViews((v) => (v ?? video?.views ?? 0) + 1),
      () => {
        /* best effort */
      },
    );
  }, [id, video?.views]);

  if (res.error instanceof ApiError && res.error.status === 404) return <VideoNotFound />;

  if (!video) {
    if (res.error) {
      return (
        <div className="page page--narrow">
          <ErrorNotice title="Запись не загрузилась" message={errorMessage(res.error)} onRetry={res.reload} />
        </div>
      );
    }
    return (
      <div className="page page--narrow vod" aria-busy="true">
        <div className="skeleton channel__stage-skeleton" />
        <div className="skeleton" style={{ height: 28, width: '50%', marginTop: 24 }} />
        <div className="skeleton" style={{ height: 18, width: '30%', marginTop: 12 }} />
      </div>
    );
  }

  const channel = ch.data?.channel ?? video.channel;
  const own = auth.status === 'authed' && auth.channel.slug.toLowerCase() === channel.slug.toLowerCase();
  const gated = channel.mature && !own && !(consented ?? hasMatureConsent(channel.slug));
  const liveNow = ch.data?.live ?? null;
  const others = (more.data?.videos ?? []).filter((v) => v.id !== video.id).slice(0, 8);
  const title = video.title.trim() || `Эфир ${formatDate(video.startedAt)}`;

  const doDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteVideo(video.id);
      setConfirmOpen(false);
      await navigate(`/${channel.slug}?tab=videos`, { replace: true });
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleting(false);
    }
  };

  return (
    <div className="page page--narrow vod">
      <div className="channel__stage vod__stage" ref={stageRef} tabIndex={-1}>
        {gated ? (
          <MatureGate
            slug={channel.slug}
            displayName={channel.displayName}
            onAccept={() => {
              setConsented(true);
              window.requestAnimationFrame(() => stageRef.current?.querySelector<HTMLElement>('.player')?.focus());
            }}
          />
        ) : (
          <Player
            mode="vod"
            src={video.playbackUrl}
            renditions={video.renditions}
            live={false}
            poster={video.thumbnailUrl}
            label={`Запись: ${title}`}
            resumeId={video.id}
            durationHint={video.durationSec}
            onWatched={onWatched}
          />
        )}
      </div>

      {liveNow ? (
        <Link to={`/${channel.slug}`} className="vod__live">
          <span className="live-dot" aria-hidden="true" />
          <span>
            <strong>{channel.displayName} сейчас в эфире.</strong> Перейти к трансляции
          </span>
          <Radio aria-hidden="true" />
        </Link>
      ) : null}

      <div className="vod__head">
        <div className="vod__titles">
          <h1 className="vod__title">{title}</h1>
          <p className="vod__meta">
            <span className="num">{viewsLabel(views ?? video.views)}</span>
            <span className="tile__sep" aria-hidden="true" />
            <time dateTime={video.startedAt}>{formatDateTime(video.startedAt)}</time>
            {video.category ? (
              <>
                <span className="tile__sep" aria-hidden="true" />
                <Link to={categoryHref(video.category)} className="vod__cat">
                  {video.category}
                </Link>
              </>
            ) : null}
          </p>
          <p className="vod__expires">
            <CalendarX aria-hidden="true" />
            Запись будет удалена {formatDate(video.expiresAt)}
          </p>
        </div>
        {own ? (
          <button type="button" className="btn btn--danger" onClick={() => setConfirmOpen(true)}>
            <Trash2 aria-hidden="true" />
            Удалить запись
          </button>
        ) : null}
      </div>

      <div className="vod__channel">
        <Link to={`/${channel.slug}`} className="vod__who">
          <Avatar channel={channel} size={48} live={liveNow !== null} />
          <span className="vod__who-text">
            <span className="vod__who-name">{channel.displayName}</span>
            <span className="vod__who-sub num">{followersLabel(channel.followers ?? 0)}</span>
          </span>
        </Link>
        {!own ? (
          <FollowButton
            slug={channel.slug}
            displayName={channel.displayName}
            following={auth.status === 'authed' ? (ch.data?.viewer?.following ?? false) : null}
            followers={channel.followers ?? 0}
            onChange={(r) =>
              ch.mutate((prev) =>
                prev
                  ? { ...prev, channel: { ...prev.channel, followers: r.followers }, viewer: { following: r.following } }
                  : prev,
              )
            }
          />
        ) : null}
      </div>

      {others.length ? (
        <section className="vod__more" aria-labelledby="more-h">
          <h2 className="h-section browse__section-title" id="more-h">
            Другие записи канала
          </h2>
          <ul className="grid">
            {others.map((v: Video) => (
              <li key={v.id}>
                <VideoTile video={v} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Удалить запись?"
        confirmLabel="Удалить запись"
        danger
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => {
          setConfirmOpen(false);
          setDeleteError(null);
        }}
      >
        <p>«{title}» пропадёт с канала для всех зрителей. Отменить удаление нельзя.</p>
        {deleteError ? (
          <p className="field__error" role="alert">
            <TriangleAlert aria-hidden="true" />
            {deleteError}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
