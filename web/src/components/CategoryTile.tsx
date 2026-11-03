import { Link } from 'react-router';
import type { Category } from '../api/types';
import { formatCount, hueFor, plural, viewersWord } from '../lib/format';
import { categoryHref } from './header/HeaderSearch';
import { Thumb } from './Thumb';

/** A category "bin": live frame when someone is on air, otherwise the name set as a title card. */
export function CategoryTile({ category, thumbTick }: { category: Category; thumbTick?: number }) {
  const live = category.liveCount > 0;
  const hue = hueFor(category.name.toLowerCase());
  const thumb = category.thumbnailUrl
    ? `${category.thumbnailUrl}${category.thumbnailUrl.includes('?') ? '&' : '?'}t=${thumbTick ?? 0}`
    : null;
  return (
    <article className="cat" data-live={live ? 'true' : 'false'}>
      <div className="cat__screen" style={{ ['--cat-hue' as string]: hue }}>
        <div className="cat__card" aria-hidden="true">
          <span className="cat__card-name">{category.name}</span>
        </div>
        {thumb ? <Thumb src={thumb} className="cat__img" /> : null}
      </div>
      <h3 className="cat__name">
        <Link to={categoryHref(category.name)} className="cat__link">
          {category.name}
        </Link>
      </h3>
      <p className="cat__stats">
        {live ? (
          <>
            <span className="cat__stat">
              <span className="live-dot" aria-hidden="true" />
              <span className="num">{formatCount(category.liveCount)}</span>{' '}
              {plural(category.liveCount, 'эфир', 'эфира', 'эфиров')}
            </span>
            <span className="cat__stat">
              <span className="num">{formatCount(category.viewers)}</span> {viewersWord(category.viewers)}
            </span>
          </>
        ) : (
          <span className="cat__stat">популярно за месяц</span>
        )}
      </p>
    </article>
  );
}
