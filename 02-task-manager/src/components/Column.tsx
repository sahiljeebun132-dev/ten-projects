import { useState } from 'react';
import { STATUS_LABELS, type Status, type Task } from '../types';
import { TaskCard } from './TaskCard';

interface ColumnProps {
  status: Status;
  tasks: readonly Task[];
  today: string;
  draggingId: string | null;
  onEdit: (task: Task) => void;
  onDuplicate: (id: string) => void;
  onDelete: (task: Task) => void;
  onMove: (id: string, status: Status) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onAdd: (status: Status) => void;
}

export function Column({
  status,
  tasks,
  today,
  draggingId,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onDragStart,
  onDragEnd,
  onAdd,
}: ColumnProps): JSX.Element {
  const [isOver, setIsOver] = useState(false);

  function handleDragOver(event: React.DragEvent<HTMLElement>): void {
    // `draggingId` may not have flushed yet on the very first dragover, so fall
    // back to the payload type the card sets in its dragstart handler.
    if (!draggingId && !event.dataTransfer.types.includes('text/plain')) return;
    // Preventing default is what marks this element as a valid drop target.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!isOver) setIsOver(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLElement>): void {
    // Ignore the leave events fired when the pointer crosses a child element.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsOver(false);
  }

  function handleDrop(event: React.DragEvent<HTMLElement>): void {
    event.preventDefault();
    setIsOver(false);
    const id = event.dataTransfer.getData('text/plain') || draggingId;
    if (id) onMove(id, status);
    onDragEnd();
  }

  return (
    <section
      className={`column${isOver ? ' column--over' : ''}`}
      aria-labelledby={`col-${status}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="column__head">
        <h2 className="column__title" id={`col-${status}`}>
          {STATUS_LABELS[status]}
          <span className="column__count" aria-label={`${tasks.length} tasks`}>
            {tasks.length}
          </span>
        </h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => onAdd(status)}
          aria-label={`Add a task to ${STATUS_LABELS[status]}`}
        >
          + Add
        </button>
      </header>

      <div className="column__body">
        {tasks.length === 0 ? (
          <p className="column__empty">
            {draggingId ? 'Drop here' : 'Nothing here yet.'}
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              today={today}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              onMove={onMove}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              isDragging={draggingId === task.id}
            />
          ))
        )}
      </div>
    </section>
  );
}
