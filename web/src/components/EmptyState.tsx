import { RotateCcw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

/** Quiet "nothing here yet" block: one line of direction plus an optional action. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__monitor" aria-hidden="true" />
      <h2 className="empty__title">{title}</h2>
      {children ? <div className="empty__text">{children}</div> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

/** Error notice with a retry button, as used across pages. */
export function ErrorNotice({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="notice notice--error" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div className="notice__body">
        <strong>{title}</strong>
        <span>{message}</span>
        {onRetry ? (
          <div className="notice__actions">
            <button type="button" className="btn btn--sm" onClick={onRetry}>
              <RotateCcw aria-hidden="true" />
              Повторить
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
