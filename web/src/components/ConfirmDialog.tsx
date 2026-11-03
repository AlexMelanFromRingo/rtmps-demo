import { useEffect, useId, useRef, type ReactNode } from 'react';

type Props = {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Modal confirmation built on <dialog> (native focus trap, Esc to cancel). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Отмена',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        // Click on the backdrop closes the dialog.
        if (e.target === ref.current && !busy) onCancel();
      }}
    >
      <div className="dialog__body">
        <h2 className="dialog__title" id={titleId}>
          {title}
        </h2>
        <div className="dialog__text" id={textId}>
          {children}
        </div>
        <div className="dialog__actions">
          <button ref={cancelRef} type="button" className="btn btn--outline" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger-solid' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
