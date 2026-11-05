import { useCallback, useEffect, useRef } from 'react';

/**
 * Wraps `announce` so that at most one message goes out per `intervalMs`.
 * Messages arriving in between replace each other: the latest one is sent
 * when the interval ends, so a final "All done" is never lost.
 */
export function useThrottledAnnounce(announce: (text: string) => void, intervalMs = 2000) {
  const last = useRef(-Infinity);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return useCallback(
    (text: string) => {
      const now = Date.now();
      if (now - last.current >= intervalMs && timer.current === undefined) {
        last.current = now;
        announce(text);
        return;
      }
      pending.current = text;
      if (timer.current !== undefined) return;
      timer.current = setTimeout(
        () => {
          timer.current = undefined;
          last.current = Date.now();
          if (pending.current !== null) announce(pending.current);
          pending.current = null;
        },
        Math.max(0, intervalMs - (now - last.current)),
      );
    },
    [announce, intervalMs],
  );
}
