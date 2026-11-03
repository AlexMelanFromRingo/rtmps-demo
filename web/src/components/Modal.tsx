import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Prevent closing (Esc / backdrop) while a request is in flight. */
  busy?: boolean;
  wide?: boolean;
};

/**
 * Modal built on <dialog>: native focus trap and Esc; focus returns to the opener on close.
 * The first field with `autoFocus` (or the dialog itself) receives focus.
 */
export function Modal({ open, title, onClose, children, busy = false, wide = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      d.showModal();
      const first = d.querySelector<HTMLElement>('[data-autofocus]');
      first?.focus();
    } else if (!open && d.open) {
      d.close();
      opener.current?.focus?.();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog modal${wide ? ' modal--wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose();
      }}
    >
      {open ? (
        <div className="dialog__body">
          <div className="modal__head">
            <h2 className="dialog__title" id={titleId}>
              {title}
            </h2>
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--icon"
              onClick={onClose}
              disabled={busy}
              aria-label="Закрыть"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
