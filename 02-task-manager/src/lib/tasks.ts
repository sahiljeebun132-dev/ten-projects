import {
  PRIORITY_RANK,
  isPriority,
  isStatus,
  type Filters,
  type Priority,
  type SortKey,
  type Status,
  type Task,
  type TaskDraft,
} from '../types';

export function createId(): string {
  const cryptoRef = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** `YYYY-MM-DD` for today in the viewer's own timezone (not UTC). */
export function todayISO(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function shiftDays(days: number, from: Date = new Date()): string {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return todayISO(next);
}

/**
 * A task is overdue when it has a due date strictly before today and it has not
 * been completed. Comparing the `YYYY-MM-DD` strings is safe because the format
 * is lexicographically ordered, and it dodges timezone drift from `Date` parsing.
 */
export function isOverdue(task: Task, today: string = todayISO()): boolean {
  if (!task.dueDate || task.status === 'done') return false;
  return task.dueDate < today;
}

export function isDueToday(task: Task, today: string = todayISO()): boolean {
  return Boolean(task.dueDate) && task.status !== 'done' && task.dueDate === today;
}

export function formatDueDate(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || !month || !day) return iso;
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function relativeDueLabel(iso: string, today: string = todayISO()): string {
  if (!iso) return '';
  if (iso === today) return 'Due today';
  const diff = daysBetween(today, iso);
  if (diff === 1) return 'Due tomorrow';
  if (diff === -1) return '1 day overdue';
  if (diff < 0) return `${Math.abs(diff)} days overdue`;
  return `Due in ${diff} days`;
}

function daysBetween(fromISO: string, toISO: string): number {
  const from = Date.parse(`${fromISO}T00:00:00`);
  const to = Date.parse(`${toISO}T00:00:00`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

export function normaliseTags(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : input.split(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const tag = String(entry).trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function draftFromTask(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    dueDate: task.dueDate,
    tags: [...task.tags],
    status: task.status,
  };
}

export function emptyDraft(status: Status = 'backlog'): TaskDraft {
  return { title: '', description: '', priority: 'med', dueDate: '', tags: [], status };
}

export function taskFromDraft(draft: TaskDraft): Task {
  return {
    id: createId(),
    createdAt: new Date().toISOString(),
    ...draft,
    title: draft.title.trim(),
    description: draft.description.trim(),
    tags: normaliseTags(draft.tags),
  };
}

export function duplicateTask(task: Task): Task {
  return {
    ...task,
    id: createId(),
    createdAt: new Date().toISOString(),
    title: `${task.title} (copy)`,
    tags: [...task.tags],
  };
}

/** Every distinct tag across the board, alphabetised, for the filter dropdown. */
export function collectTags(tasks: readonly Task[]): string[] {
  const set = new Set<string>();
  for (const task of tasks) for (const tag of task.tags) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function matchesSearch(task: Task, query: string): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    task.title.toLowerCase().includes(needle) ||
    task.description.toLowerCase().includes(needle) ||
    task.tags.some((tag) => tag.includes(needle))
  );
}

export function filterTasks(tasks: readonly Task[], filters: Filters): Task[] {
  return tasks.filter((task) => {
    if (!matchesSearch(task, filters.search)) return false;
    if (filters.priority !== 'all' && task.priority !== filters.priority) return false;
    if (filters.tag !== 'all' && !task.tags.includes(filters.tag)) return false;
    return true;
  });
}

/**
 * Sorting is stable and total: ties fall back to creation time (newest first)
 * so the board never reshuffles arbitrarily between renders. Tasks without a
 * due date sort last when sorting by due date.
 */
export function sortTasks(tasks: readonly Task[], sortBy: SortKey): Task[] {
  const copy = [...tasks];
  copy.sort((a, b) => {
    switch (sortBy) {
      case 'dueDate': {
        if (a.dueDate !== b.dueDate) {
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate < b.dueDate ? -1 : 1;
        }
        break;
      }
      case 'priority': {
        const diff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
        if (diff !== 0) return diff;
        break;
      }
      case 'createdAt':
        break;
    }
    if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return copy;
}

export interface BoardStats {
  total: number;
  perStatus: Record<Status, number>;
  overdue: number;
  completion: number;
}

export function computeStats(tasks: readonly Task[], today: string = todayISO()): BoardStats {
  const perStatus: Record<Status, number> = { backlog: 0, 'in-progress': 0, done: 0 };
  let overdue = 0;
  for (const task of tasks) {
    perStatus[task.status] += 1;
    if (isOverdue(task, today)) overdue += 1;
  }
  const total = tasks.length;
  const completion = total === 0 ? 0 : Math.round((perStatus.done / total) * 100);
  return { total, perStatus, overdue, completion };
}

/** Validate an unknown value (from storage) into a Task, or `null` if unusable. */
export function parseTask(value: unknown): Task | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title : '';
  if (!title.trim()) return null;
  const priority: Priority = isPriority(raw.priority) ? raw.priority : 'med';
  const status: Status = isStatus(raw.status) ? raw.status : 'backlog';
  const tags = Array.isArray(raw.tags) ? normaliseTags(raw.tags.map((t) => String(t))) : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
    title,
    description: typeof raw.description === 'string' ? raw.description : '',
    priority,
    dueDate: typeof raw.dueDate === 'string' ? raw.dueDate : '',
    tags,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    status,
  };
}

export function parseTaskList(value: unknown): Task[] | null {
  if (!Array.isArray(value)) return null;
  const out: Task[] = [];
  for (const entry of value) {
    const task = parseTask(entry);
    if (task) out.push(task);
  }
  return out;
}
