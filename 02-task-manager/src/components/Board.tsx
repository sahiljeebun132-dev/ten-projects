import { useState } from 'react';
import { STATUSES, type Status, type Task } from '../types';
import { Column } from './Column';

interface BoardProps {
  tasksByStatus: Record<Status, Task[]>;
  today: string;
  onEdit: (task: Task) => void;
  onDuplicate: (id: string) => void;
  onDelete: (task: Task) => void;
  onMove: (id: string, status: Status) => void;
  onAdd: (status: Status) => void;
}

export function Board({
  tasksByStatus,
  today,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onAdd,
}: BoardProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  return (
    <div className="board">
      {STATUSES.map((status) => (
        <Column
          key={status}
          status={status}
          tasks={tasksByStatus[status]}
          today={today}
          draggingId={draggingId}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onMove={onMove}
          onAdd={onAdd}
          onDragStart={setDraggingId}
          onDragEnd={() => setDraggingId(null)}
        />
      ))}
    </div>
  );
}
