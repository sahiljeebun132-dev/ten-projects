import { useCallback, useMemo, useState } from 'react';
import { Board } from './components/Board';
import { ConfirmDialog } from './components/ConfirmDialog';
import { FilterBar } from './components/FilterBar';
import { Header } from './components/Header';
import { StatsBar } from './components/StatsBar';
import { TaskModal } from './components/TaskModal';
import { useHotkey } from './hooks/useHotkeys';
import { useLocalStorage } from './hooks/useLocalStorage';
import { useTasks } from './hooks/useTasks';
import { useTheme } from './hooks/useTheme';
import { isPersistent, STORAGE_KEYS } from './lib/storage';
import { draftFromTask, emptyDraft, todayISO } from './lib/tasks';
import {
  STATUS_LABELS,
  isPriority,
  isSortKey,
  type Filters,
  type Status,
  type Task,
  type TaskDraft,
} from './types';

const DEFAULT_FILTERS: Filters = { search: '', priority: 'all', tag: 'all', sortBy: 'dueDate' };

function parseFilters(raw: unknown): Filters | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  return {
    search: typeof value.search === 'string' ? value.search : '',
    priority: isPriority(value.priority) ? value.priority : 'all',
    tag: typeof value.tag === 'string' ? value.tag : 'all',
    sortBy: isSortKey(value.sortBy) ? value.sortBy : 'dueDate',
  };
}

type ModalState =
  | { kind: 'closed' }
  | { kind: 'create'; draft: TaskDraft }
  | { kind: 'edit'; id: string; draft: TaskDraft };

export function App(): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const [filters, setFilters] = useLocalStorage<Filters>(STORAGE_KEYS.filters, DEFAULT_FILTERS, parseFilters);
  const tasksApi = useTasks(filters);
  const [modal, setModal] = useState<ModalState>({ kind: 'closed' });
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const today = useMemo(() => todayISO(), []);

  const openCreate = useCallback((status: Status = 'backlog') => {
    setModal({ kind: 'create', draft: emptyDraft(status) });
  }, []);

  const openEdit = useCallback((task: Task) => {
    setModal({ kind: 'edit', id: task.id, draft: draftFromTask(task) });
  }, []);

  const closeModal = useCallback(() => setModal({ kind: 'closed' }), []);

  // `n` opens the composer, but not while a dialog already owns the screen.
  useHotkey('n', () => openCreate(), { enabled: modal.kind === 'closed' && pendingDelete === null });

  const { addTask, updateTask, deleteTask, duplicateTask, moveTask, resetToSeed } = tasksApi;

  const handleSubmit = useCallback(
    (draft: TaskDraft) => {
      if (modal.kind === 'create') {
        addTask(draft);
        setAnnouncement(`Created "${draft.title}" in ${STATUS_LABELS[draft.status]}.`);
      } else if (modal.kind === 'edit') {
        updateTask(modal.id, draft);
        setAnnouncement(`Saved "${draft.title}".`);
      }
      closeModal();
    },
    [modal, addTask, updateTask, closeModal],
  );

  const handleMove = useCallback(
    (id: string, status: Status) => {
      moveTask(id, status);
      setAnnouncement(`Moved to ${STATUS_LABELS[status]}.`);
    },
    [moveTask],
  );

  const handleDuplicate = useCallback(
    (id: string) => {
      duplicateTask(id);
      setAnnouncement('Task duplicated.');
    },
    [duplicateTask],
  );

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    deleteTask(pendingDelete.id);
    setAnnouncement(`Deleted "${pendingDelete.title}".`);
    setPendingDelete(null);
  }, [pendingDelete, deleteTask]);

  const handleFilterChange = useCallback(
    (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch })),
    [setFilters],
  );

  const resetFilters = useCallback(
    () => setFilters((current) => ({ ...DEFAULT_FILTERS, sortBy: current.sortBy })),
    [setFilters],
  );

  const handleReset = useCallback(() => {
    resetToSeed();
    setAnnouncement('Board reset to the example tasks.');
  }, [resetToSeed]);

  return (
    <div className="app">
      <Header theme={theme} onToggleTheme={toggleTheme} onNewTask={() => openCreate()} />

      <main className="app__main">
        <StatsBar stats={tasksApi.stats} />

        <FilterBar
          filters={filters}
          allTags={tasksApi.allTags}
          resultCount={tasksApi.filteredCount}
          totalCount={tasksApi.stats.total}
          onChange={handleFilterChange}
          onReset={resetFilters}
        />

        {tasksApi.stats.total === 0 ? (
          <div className="blank-slate">
            <h2 className="blank-slate__title">The board is empty</h2>
            <p className="blank-slate__text">
              Press <kbd>n</kbd> or use “New task” to add the first one.
            </p>
            <button type="button" className="btn btn--ghost" onClick={handleReset}>
              Load the example tasks
            </button>
          </div>
        ) : (
          <Board
            tasksByStatus={tasksApi.visibleByStatus}
            today={today}
            onEdit={openEdit}
            onDuplicate={handleDuplicate}
            onDelete={setPendingDelete}
            onMove={handleMove}
            onAdd={openCreate}
          />
        )}
      </main>

      <footer className="app__foot">
        <p>
          {isPersistent()
            ? 'Saved in this browser only — nothing is uploaded anywhere.'
            : 'Storage is unavailable in this browser, so changes last only for this session.'}
        </p>
      </footer>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <TaskModal
        open={modal.kind !== 'closed'}
        mode={modal.kind === 'edit' ? 'edit' : 'create'}
        initial={modal.kind === 'closed' ? emptyDraft() : modal.draft}
        onSubmit={handleSubmit}
        onClose={closeModal}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this task?"
        message={
          pendingDelete
            ? `“${pendingDelete.title}” will be removed from the board. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
