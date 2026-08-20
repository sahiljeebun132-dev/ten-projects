import type { Theme } from '../types';

interface HeaderProps {
  theme: Theme;
  onToggleTheme: () => void;
  onNewTask: () => void;
}

export function Header({ theme, onToggleTheme, onNewTask }: HeaderProps): JSX.Element {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <header className="masthead">
      <div className="masthead__brand">
        <h1 className="masthead__title">Task Board</h1>
        <p className="masthead__sub">
          Press <kbd>n</kbd> for a new task, <kbd>Esc</kbd> to close.
        </p>
      </div>

      <div className="masthead__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onToggleTheme}
          aria-label={`Switch to ${nextTheme} theme`}
          title={`Switch to ${nextTheme} theme`}
        >
          <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          <span className="masthead__theme-label">{nextTheme === 'dark' ? 'Dark' : 'Light'}</span>
        </button>
        <button type="button" className="btn btn--primary" onClick={onNewTask}>
          New task
        </button>
      </div>
    </header>
  );
}
