import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { normaliseTags } from '../lib/tasks';
import { PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS, isPriority, isStatus, type TaskDraft } from '../types';

interface TaskModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  initial: TaskDraft;
  onSubmit: (draft: TaskDraft) => void;
  onClose: () => void;
}

export function TaskModal({ open, mode, initial, onSubmit, onClose }: TaskModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<TaskDraft>(initial);
  const [tagText, setTagText] = useState<string>(initial.tags.join(', '));
  const [error, setError] = useState<string>('');

  const titleId = useId();
  const fieldIds = {
    title: `${titleId}-title`,
    desc: `${titleId}-desc`,
    priority: `${titleId}-priority`,
    due: `${titleId}-due`,
    tags: `${titleId}-tags`,
    status: `${titleId}-status`,
    error: `${titleId}-error`,
  };

  // Re-seed the form whenever the modal is opened for a different task.
  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setTagText(initial.tags.join(', '));
    setError('');
  }, [open, initial]);

  useFocusTrap(dialogRef, open, onClose);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) {
      setError('Give the task a title.');
      dialogRef.current?.querySelector<HTMLInputElement>('input[data-autofocus]')?.focus();
      return;
    }
    onSubmit({ ...draft, title, tags: normaliseTags(tagText) });
  }

  const heading = mode === 'create' ? 'New task' : 'Edit task';

  return createPortal(
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${titleId}-heading`}
        ref={dialogRef}
      >
        <header className="modal__head">
          <h2 className="modal__title" id={`${titleId}-heading`}>
            {heading}
          </h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>

        <form className="modal__body" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor={fieldIds.title}>
              Title
            </label>
            <input
              id={fieldIds.title}
              className="input"
              data-autofocus
              value={draft.title}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? fieldIds.error : undefined}
              onChange={(event) => {
                setDraft((current) => ({ ...current, title: event.target.value }));
                if (error) setError('');
              }}
              placeholder="What needs doing?"
            />
            {error && (
              <p className="field__error" id={fieldIds.error} role="alert">
                {error}
              </p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor={fieldIds.desc}>
              Description
            </label>
            <textarea
              id={fieldIds.desc}
              className="input input--area"
              rows={3}
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              onKeyDown={(event) => {
                // Enter inserts a newline here; Cmd/Ctrl+Enter saves.
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Any detail worth remembering later"
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label className="field__label" htmlFor={fieldIds.priority}>
                Priority
              </label>
              <select
                id={fieldIds.priority}
                className="input"
                value={draft.priority}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isPriority(value)) setDraft((current) => ({ ...current, priority: value }));
                }}
              >
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {PRIORITY_LABELS[priority]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor={fieldIds.due}>
                Due date
              </label>
              <input
                id={fieldIds.due}
                className="input"
                type="date"
                value={draft.dueDate}
                onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))}
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor={fieldIds.status}>
                Column
              </label>
              <select
                id={fieldIds.status}
                className="input"
                value={draft.status}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isStatus(value)) setDraft((current) => ({ ...current, status: value }));
                }}
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor={fieldIds.tags}>
              Tags
            </label>
            <input
              id={fieldIds.tags}
              className="input"
              value={tagText}
              onChange={(event) => setTagText(event.target.value)}
              placeholder="design, urgent"
              aria-describedby={`${fieldIds.tags}-hint`}
            />
            <p className="field__hint" id={`${fieldIds.tags}-hint`}>
              Comma separated. Spaces become hyphens.
            </p>
          </div>

          <footer className="modal__foot">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary">
              {mode === 'create' ? 'Create task' : 'Save changes'}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
