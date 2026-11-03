import type { RecentBroadcast } from '../../api/types';
import {
  codecLabel,
  formatCount,
  formatDateTime,
  formatDuration,
  formatRelativeDay,
  protocolLabel,
  resolutionLabel,
  sinceMs,
} from '../../lib/format';

export function RecentBroadcasts({ recent }: { recent: RecentBroadcast[] }) {
  return (
    <section className="panel recent" aria-labelledby="recent-h">
      <h2 className="h-section" id="recent-h">
        Последние эфиры
      </h2>
      {recent.length === 0 ? (
        <p className="muted recent__empty">Здесь появятся ваши прошлые трансляции.</p>
      ) : (
        <div className="recent__wrap">
          <table className="recent__table">
            <thead>
              <tr>
                <th scope="col">Трансляция</th>
                <th scope="col">Начало</th>
                <th scope="col">Длительность</th>
                <th scope="col" className="recent__num">
                  Пик зрителей
                </th>
                <th scope="col">Источник</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((b) => {
                const source = [
                  protocolLabel(b.protocol),
                  b.videoCodec ? codecLabel(b.videoCodec) : null,
                  resolutionLabel(b.height),
                ].filter(Boolean);
                return (
                  <tr key={b.id}>
                    <th scope="row" className="recent__title">
                      <span>{b.title || 'Без названия'}</span>
                      {b.category ? <span className="recent__cat">{b.category}</span> : null}
                    </th>
                    <td data-label="Начало">
                      <span className="recent__date">{formatDateTime(b.startedAt)}</span>
                      <span className="recent__rel">{formatRelativeDay(b.startedAt)}</span>
                    </td>
                    <td data-label="Длительность" className="num">
                      {b.endedAt ? (
                        formatDuration(sinceMs(b.startedAt, Date.parse(b.endedAt)))
                      ) : (
                        <span className="recent__now">идёт сейчас</span>
                      )}
                    </td>
                    <td data-label="Пик зрителей" className="recent__num num">
                      {formatCount(b.peakViewers)}
                    </td>
                    <td data-label="Источник">
                      {source.length ? (
                        <span className="chips">
                          {source.map((s) => (
                            <span key={s} className="chip">
                              {s}
                            </span>
                          ))}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
