import { useEffect, useRef, useState } from 'react';
import { readJSON, writeJSON } from '../lib/storage';

/**
 * `useState` that mirrors its value into `localStorage`.
 *
 * `parse` validates whatever is already on disk, so a hand-edited or
 * out-of-date entry can never put a malformed value into React state.
 */
export function useLocalStorage<T>(
  key: string,
  initial: T | (() => T),
  parse: (raw: unknown) => T | null,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initial === 'function' ? (initial as () => T)() : initial;
    return readJSON(key, parseRef.current, fallback);
  });

  useEffect(() => {
    writeJSON(key, value);
  }, [key, value]);

  return [value, setValue];
}
