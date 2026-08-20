import { useCallback, useMemo } from 'react';
import { STORAGE_KEYS } from '../lib/storage';
import { buildSeedTasks } from '../lib/seed';
import {
  collectTags,
  computeStats,
  duplicateTask as cloneTask,
  filterTasks,
  parseTaskList,
  sortTasks,
  taskFromDraft,
  type BoardStats,
} from '../lib/tasks';
import { STATUSES, type Filters, type Status, type Task, type TaskDraft } from '../types';
import { useLocalStorage } from './useLocalStorage';

/**
 * Example tasks for a genuine first run only.
 *
 * This is used purely as the fallback when nothing is stored yet, and it must
 * stay side-effect free: React StrictMode invokes state initialisers twice in
 * development, so anything that wrote a "have seeded" marker here would see its
 * own marker on the second pass and hand back an empty board.
 *
 * Presence of the stored key is the real marker. The moment the board renders,
 * the persistence effect writes the tasks array, so a user who deletes every
 * task ends up with a stored `[]` and never gets the examples pushed back in.
 */
function initialTasks(): Task[] {
  return buildSeedTasks();
}

export interface TasksApi {
  tasks: Task[];
  visibleByStatus: Record<Status, Task[]>;
  allTags: string[];
  stats: BoardStats;
  filteredCount: number;
  addTask: (draft: TaskDraft) => void;
  updateTask: (id: string, draft: TaskDraft) => void;
  deleteTask: (id: string) => void;
  duplicateTask: (id: string) => void;
  moveTask: (id: string, status: Status) => void;
  resetToSeed: () => void;
}

export function useTasks(filters: Filters): TasksApi {
  const [tasks, setTasks] = useLocalStorage<Task[]>(STORAGE_KEYS.tasks, initialTasks, parseTaskList);

  const addTask = useCallback(
    (draft: TaskDraft) => {
      setTasks((current) => [taskFromDraft(draft), ...current]);
    },
    [setTasks],
  );

  const updateTask = useCallback(
    (id: string, draft: TaskDraft) => {
      setTasks((current) =>
        current.map((task) =>
          task.id === id
            ? {
                ...task,
                ...draft,
                title: draft.title.trim(),
                description: draft.description.trim(),
                tags: [...draft.tags],
              }
            : task,
        ),
      );
    },
    [setTasks],
  );

  const deleteTask = useCallback(
    (id: string) => {
      setTasks((current) => current.filter((task) => task.id !== id));
    },
    [setTasks],
  );

  const duplicateTask = useCallback(
    (id: string) => {
      setTasks((current) => {
        const index = current.findIndex((task) => task.id === id);
        const original = current[index];
        if (!original) return current;
        const copy = cloneTask(original);
        return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
      });
    },
    [setTasks],
  );

  const moveTask = useCallback(
    (id: string, status: Status) => {
      setTasks((current) => {
        const target = current.find((task) => task.id === id);
        if (!target || target.status === status) return current;
        return current.map((task) => (task.id === id ? { ...task, status } : task));
      });
    },
    [setTasks],
  );

  const resetToSeed = useCallback(() => {
    setTasks(buildSeedTasks());
  }, [setTasks]);

  const filtered = useMemo(() => filterTasks(tasks, filters), [tasks, filters]);

  const visibleByStatus = useMemo(() => {
    const sorted = sortTasks(filtered, filters.sortBy);
    const grouped: Record<Status, Task[]> = { backlog: [], 'in-progress': [], done: [] };
    for (const status of STATUSES) {
      grouped[status] = sorted.filter((task) => task.status === status);
    }
    return grouped;
  }, [filtered, filters.sortBy]);

  const allTags = useMemo(() => collectTags(tasks), [tasks]);
  const stats = useMemo(() => computeStats(tasks), [tasks]);

  return {
    tasks,
    visibleByStatus,
    allTags,
    stats,
    filteredCount: filtered.length,
    addTask,
    updateTask,
    deleteTask,
    duplicateTask,
    moveTask,
    resetToSeed,
  };
}
