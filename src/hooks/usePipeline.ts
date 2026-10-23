import { useCallback, useEffect, useReducer, useRef } from 'react';
import { processImage, type ApiClient, type ProcessOptions } from '../api/client';
import { initialRunState, runReducer } from '../state/pipeline';

/** Runs one analysis at a time and exposes the reducer state. */
export function usePipeline(api: ApiClient) {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const current = useRef<AbortController | null>(null);

  const start = useCallback(
    async (file: File, options: ProcessOptions) => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      const mine = () => current.current === controller;
      dispatch({ type: 'start', at: Date.now() });

      const outcome = await processImage({
        api,
        file,
        options,
        signal: controller.signal,
        onEvent: (event) => {
          if (mine()) dispatch({ type: 'event', event });
        },
      });
      if (!mine()) return; // superseded by a newer run
      if (outcome.type === 'failed') dispatch({ type: 'fail', error: outcome.error });
      else if (outcome.type === 'cancelled') dispatch({ type: 'cancel' });
      dispatch({ type: 'streamEnded' });
      current.current = null;
    },
    [api],
  );

  const cancel = useCallback(() => current.current?.abort(), []);
  const reset = useCallback(() => {
    current.current?.abort();
    current.current = null;
    dispatch({ type: 'reset' });
  }, []);

  useEffect(() => () => current.current?.abort(), []);

  return { state, start, cancel, reset };
}
