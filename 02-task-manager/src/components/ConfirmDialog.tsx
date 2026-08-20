import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, open, onCancel);

  if (!open) return null;

  return createPortal(
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        className="modal modal--sm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-desc`}
        ref={ref}
      >
        <header className="modal__head">
          <h2 className="modal__title" id={`${id}-title`}>
            {title}
          </h2>
        </header>
        <div className="modal__body">
          <p className="modal__text" id={`${id}-desc`}>
            {message}
          </p>
          <footer className="modal__foot">
            <button type="button" className="btn btn--ghost" onClick={onCancel} data-autofocus>
              Cancel
            </button>
            <button type="button" className="btn btn--primary btn--danger-solid" onClick={onConfirm}>
              {confirmLabel}
            </button>
          </footer>
        </div>
      </div>
    </div>,
    document.body,
  );
}
