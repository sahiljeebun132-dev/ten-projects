import { PRIORITY_LABELS, type Status, type Task } from '../types';
import { formatDueDate, isDueToday, isOverdue, relativeDueLabel } from '../lib/tasks';
import { MoveMenu } from './MoveMenu';

interface TaskCardProps {
  task: Task;
  today: string;
  onEdit: (task: Task) => void;
  onDuplicate: (id: string) => void;
  onDelete: (task: Task) => void;
  onMove: (id: string, status: Status) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}

export function TaskCard({
  task,
  today,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onDragStart,
  onDragEnd,
  isDragging,
}: TaskCardProps): JSX.Element {
  const overdue = isOverdue(task, today);
  const dueToday = isDueToday(task, today);

  function handleDragStart(event: React.DragEvent<HTMLElement>): void {
    event.dataTransfer.setData('text/plain', task.id);
    event.dataTransfer.effectAllowed = 'move';
    onDragStart(task.id);
  }

  return (
    <article
      className={`card card--${task.priority}${isDragging ? ' card--dragging' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
      aria-label={`${task.title}, ${PRIORITY_LABELS[task.priority]} priority`}
    >
      <div className="card__top">
        <span className={`pill pill--${task.priority}`}>{PRIORITY_LABELS[task.priority]}</span>
        {task.dueDate && (
          <span
            className={`due${overdue ? ' due--overdue' : ''}${dueToday ? ' due--today' : ''}`}
            title={relativeDueLabel(task.dueDate, today)}
          >
            {overdue && (
              <span className="visually-hidden">Overdue. </span>
            )}
            {formatDueDate(task.dueDate)}
          </span>
        )}
      </div>

      <h3 className="card__title">{task.title}</h3>
      {task.description && <p className="card__desc">{task.description}</p>}

      {task.tags.length > 0 && (
        <ul className="tags" aria-label="Tags">
          {task.tags.map((tag) => (
            <li key={tag} className="tag">
              #{tag}
            </li>
          ))}
        </ul>
      )}

      <div className="card__actions">
        <MoveMenu taskTitle={task.title} current={task.status} onMove={(status) => onMove(task.id, status)} />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onEdit(task)}>
          Edit<span className="visually-hidden"> {task.title}</span>
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDuplicate(task.id)}>
          Duplicate<span className="visually-hidden"> {task.title}</span>
        </button>
        <button type="button" className="btn btn--ghost btn--sm btn--danger" onClick={() => onDelete(task)}>
          Delete<span className="visually-hidden"> {task.title}</span>
        </button>
      </div>
    </article>
  );
}
