import { useId } from 'react';
import {
  PRIORITIES,
  PRIORITY_LABELS,
  SORT_KEYS,
  SORT_LABELS,
  isPriority,
  isSortKey,
  type Filters,
} from '../types';

interface FilterBarProps {
  filters: Filters;
  allTags: readonly string[];
  resultCount: number;
  totalCount: number;
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
}

export function FilterBar({
  filters,
  allTags,
  resultCount,
  totalCount,
  onChange,
  onReset,
}: FilterBarProps): JSX.Element {
  const searchId = useId();
  const priorityId = useId();
  const tagId = useId();
  const sortId = useId();

  const isFiltered = filters.search !== '' || filters.priority !== 'all' || filters.tag !== 'all';

  return (
    <section className="filters" aria-label="Filter and sort tasks">
      <div className="filters__field filters__field--grow">
        <label className="filters__label" htmlFor={searchId}>
          Search
        </label>
        <input
          id={searchId}
          className="input"
          type="search"
          placeholder="Search title, description or tag"
          value={filters.search}
          onChange={(event) => onChange({ search: event.target.value })}
        />
      </div>

      <div className="filters__field">
        <label className="filters__label" htmlFor={priorityId}>
          Priority
        </label>
        <select
          id={priorityId}
          className="input"
          value={filters.priority}
          onChange={(event) => {
            const value = event.target.value;
            onChange({ priority: isPriority(value) ? value : 'all' });
          }}
        >
          <option value="all">All priorities</option>
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </option>
          ))}
        </select>
      </div>

      <div className="filters__field">
        <label className="filters__label" htmlFor={tagId}>
          Tag
        </label>
        <select
          id={tagId}
          className="input"
          value={filters.tag}
          onChange={(event) => onChange({ tag: event.target.value })}
        >
          <option value="all">All tags</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>
              #{tag}
            </option>
          ))}
        </select>
      </div>

      <div className="filters__field">
        <label className="filters__label" htmlFor={sortId}>
          Sort by
        </label>
        <select
          id={sortId}
          className="input"
          value={filters.sortBy}
          onChange={(event) => {
            const value = event.target.value;
            if (isSortKey(value)) onChange({ sortBy: value });
          }}
        >
          {SORT_KEYS.map((key) => (
            <option key={key} value={key}>
              {SORT_LABELS[key]}
            </option>
          ))}
        </select>
      </div>

      <div className="filters__meta">
        <p className="filters__count" role="status">
          {isFiltered ? `${resultCount} of ${totalCount} shown` : `${totalCount} ${totalCount === 1 ? 'task' : 'tasks'}`}
        </p>
        {isFiltered && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={onReset}>
            Clear filters
          </button>
        )}
      </div>
    </section>
  );
}
