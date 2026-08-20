export const STATUSES = ['backlog', 'in-progress', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ['low', 'med', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  /** ISO date string (YYYY-MM-DD) or empty string when no due date is set. */
  dueDate: string;
  tags: string[];
  /** Full ISO timestamp of creation. */
  createdAt: string;
  status: Status;
}

/** The shape used by the create/edit form before it becomes a Task. */
export type TaskDraft = Omit<Task, 'id' | 'createdAt'>;

export type Theme = 'light' | 'dark';

export const SORT_KEYS = ['dueDate', 'priority', 'createdAt'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface Filters {
  search: string;
  priority: Priority | 'all';
  tag: string | 'all';
  sortBy: SortKey;
}

export const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  'in-progress': 'In Progress',
  done: 'Done',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  med: 'Medium',
  high: 'High',
};

export const SORT_LABELS: Record<SortKey, string> = {
  dueDate: 'Due date',
  priority: 'Priority',
  createdAt: 'Created date',
};

/** Higher number = more urgent, used when sorting. */
export const PRIORITY_RANK: Record<Priority, number> = {
  high: 3,
  med: 2,
  low: 1,
};

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);
}
