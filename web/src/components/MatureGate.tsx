import { Link } from 'react-router';
import { giveMatureConsent } from '../lib/browser';

/**
 * 18+ slate shown in place of the picture until the viewer confirms.
 * Consent is remembered per channel in localStorage.
 */
export function MatureGate({ slug, displayName, onAccept }: { slug: string; displayName: string; onAccept: () => void }) {
  return (
    <div className="stage slate" role="region" aria-labelledby="slate-h">
      <div className="slate__frame">
        <span className="slate__mark" aria-hidden="true">
          18+
        </span>
        <div className="slate__text">
          <h2 className="slate__title" id="slate-h">
            Контент 18+
          </h2>
          <p>
            Канал «{displayName}» отмечен как контент для взрослых: здесь может быть грубая лексика, насилие или
            откровенные сцены.
          </p>
          <div className="slate__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                giveMatureConsent(slug);
                onAccept();
              }}
            >
              Мне есть 18, смотреть
            </button>
            <Link to="/" className="btn btn--outline">
              Вернуться в каталог
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
