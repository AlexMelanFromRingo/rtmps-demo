import { Heart, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Link } from 'react-router';
import type { ChannelWithLive } from '../api/types';
import { useFollowing } from '../lib/following';
import { formatCompact, viewersLabel } from '../lib/format';
import { Avatar } from './Avatar';
import './FollowRail.css';

/** Live followed channels as a vertical list (sidebar, mobile drawer). */
export function FollowedLiveList({ entries, compact = false }: { entries: ChannelWithLive[]; compact?: boolean }) {
  return (
    <ul className="flist" data-compact={compact ? 'true' : 'false'}>
      {entries.map(({ channel, live }) => {
        const viewers = live ? viewersLabel(live.viewers) : 'не в эфире';
        return (
          <li key={channel.slug}>
            <Link
              to={`/${channel.slug}`}
              className="flist__item"
              title={compact ? `${channel.displayName} — ${viewers}` : undefined}
              aria-label={compact ? `${channel.displayName}, ${viewers}` : undefined}
            >
              <Avatar channel={channel} size={32} live={live !== null} />
              <span className="flist__text">
                <span className="flist__name">{channel.displayName}</span>
                <span className="flist__cat">{channel.category || channel.title || 'В эфире'}</span>
              </span>
              {live ? (
                <span className="flist__viewers num">
                  <span className="live-dot" aria-hidden="true" />
                  <span className="visually-hidden">{viewers}</span>
                  <span aria-hidden="true">{formatCompact(live.viewers)}</span>
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Twitch-style left rail with followed channels that are live. Wide screens only. */
export function FollowRail({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { entries, live, error } = useFollowing();
  const offline = entries ? entries.length - live.length : 0;

  return (
    <aside className="rail" data-collapsed={collapsed ? 'true' : 'false'} aria-labelledby="rail-h">
      <div className="rail__inner">
        <div className="rail__head">
          <h2 className="rail__title" id="rail-h">
            Отслеживаемые
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon rail__toggle"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Развернуть панель отслеживаемых' : 'Свернуть панель отслеживаемых'}
            title={collapsed ? 'Развернуть' : 'Свернуть'}
          >
            {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
          </button>
        </div>

        {entries === null ? (
          error ? (
            <p className="rail__note">Список не загрузился. Повторим через минуту.</p>
          ) : (
            <div className="rail__skeleton" aria-busy="true" aria-label="Загружаем">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="rail__skel-row" aria-hidden="true">
                  <span className="skeleton rail__skel-avatar" />
                  <span className="skeleton rail__skel-line" />
                </div>
              ))}
            </div>
          )
        ) : live.length ? (
          <FollowedLiveList entries={live} compact={collapsed} />
        ) : entries.length === 0 ? (
          <p className="rail__note">
            Нажмите <Heart aria-hidden="true" className="rail__inline-icon" /> «Отслеживать» на странице канала —
            здесь будет видно, кто из них в эфире.
          </p>
        ) : (
          <p className="rail__note">Никто из отслеживаемых сейчас не в эфире.</p>
        )}

        {entries && entries.length > 0 ? (
          <Link to="/following" className="rail__all" title={collapsed ? 'Все отслеживаемые' : undefined}>
            {collapsed ? (
              <>
                <Heart aria-hidden="true" />
                <span className="visually-hidden">Все отслеживаемые</span>
              </>
            ) : offline > 0 ? (
              `Все отслеживаемые (${entries.length})`
            ) : (
              'Все отслеживаемые'
            )}
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
