import { useEffect, useId, useRef, useState } from 'react';
import { STATUSES, STATUS_LABELS, type Status } from '../types';

interface MoveMenuProps {
  taskTitle: string;
  current: Status;
  onMove: (status: Status) => void;
}

/**
 * Keyboard-operable alternative to dragging a card. Native HTML5 drag and drop
 * is mouse-only, so every card also exposes this menu; it is a real focusable
 * button with a `menu` popup rather than a hover-only affordance.
 */
export function MoveMenu({ taskTitle, current, onMove }: MoveMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent): void {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const first = wrapperRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]');
    first?.focus();
  }, [open]);

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(wrapperRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    if (items.length === 0) return;
    const index = items.findIndex((item) => item === document.activeElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(index + delta + items.length) % items.length];
    next?.focus();
  }

  return (
    <div className="move-menu" ref={wrapperRef}>
      <button
        type="button"
        ref={triggerRef}
        className="btn btn--ghost btn--sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Move
      </button>
      {open && (
        <div
          className="move-menu__list"
          id={menuId}
          role="menu"
          aria-label={`Move "${taskTitle}" to another column`}
          onKeyDown={handleMenuKeyDown}
        >
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              role="menuitemradio"
              aria-checked={status === current}
              className="move-menu__item"
              disabled={status === current}
              onClick={() => {
                onMove(status);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span aria-hidden="true" className="move-menu__tick">
                {status === current ? '✓' : ''}
              </span>
              {STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
