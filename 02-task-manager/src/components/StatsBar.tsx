import { STATUSES, STATUS_LABELS } from '../types';
import type { BoardStats } from '../lib/tasks';

interface StatsBarProps {
  stats: BoardStats;
}

export function StatsBar({ stats }: StatsBarProps): JSX.Element {
  const { perStatus, overdue, completion, total } = stats;

  return (
    <section className="stats" aria-label="Board statistics">
      <ul className="stats__list">
        {STATUSES.map((status) => (
          <li key={status} className="stat">
            <span className="stat__value">{perStatus[status]}</span>
            <span className="stat__label">{STATUS_LABELS[status]}</span>
          </li>
        ))}
        <li className={`stat${overdue > 0 ? ' stat--alert' : ''}`}>
          <span className="stat__value">{overdue}</span>
          <span className="stat__label">Overdue</span>
        </li>
      </ul>

      <div className="stats__progress">
        <div className="stats__progress-head">
          <span className="stat__label">Completion</span>
          <span className="stats__percent">{completion}%</span>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-valuenow={completion}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${completion}% of tasks complete`}
        >
          <div className="progress__fill" style={{ width: `${completion}%` }} />
        </div>
        <p className="stats__caption">
          {perStatus.done} of {total} {total === 1 ? 'task' : 'tasks'} done
        </p>
      </div>
    </section>
  );
}
