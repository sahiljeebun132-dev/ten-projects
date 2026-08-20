import { useEffect } from 'react';

/** True when focus sits somewhere that swallows plain letter keys. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

interface HotkeyOptions {
  /** When false the listener stays attached but ignores the key. */
  enabled?: boolean;
}

/**
 * Global single-key shortcut. Ignores presses while the user is typing in a
 * field and any press carrying a modifier, so browser and OS shortcuts
 * (Cmd+N, Ctrl+N) keep working normally.
 */
export function useHotkey(key: string, handler: () => void, options: HotkeyOptions = {}): void {
  const { enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, handler, enabled]);
}
