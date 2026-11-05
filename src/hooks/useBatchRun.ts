import { useCallback, useEffect, useReducer, useRef } from 'react';
import { runGroups, type GroupPlan } from '../api/batchClient';
import type { ApiClient, ProcessOptions } from '../api/client';
import {
  batchReducer,
  initialBatchState,
  isRetryable,
  type BatchAction,
  type NewItem,
} from '../state/batch';
import { splitIntoGroups, type SplitLimits } from '../state/batchSplit';

/** How often buffered stream events are rendered. */
export const FLUSH_MS = 100;

function plan(
  entries: { index: number; file: File }[],
  limits: SplitLimits,
): { groups: number[][]; plans: GroupPlan[] } {
  const split = splitIntoGroups(entries, (e) => e.file.size, limits);
  return {
    groups: split.map((g) => g.map((e) => e.index)),
    plans: split.map((g) => ({ indices: g.map((e) => e.index), files: g.map((e) => e.file) })),
  };
}

/**
 * Runs a batch (auto-split into groups) and exposes the reducer state.
 * Stream events are buffered and applied every FLUSH_MS, so twenty images do
 * not cause hundreds of renders; control actions flush the buffer first so
 * the order is kept.
 */
export function useBatchRun(api: ApiClient) {
  const [state, dispatch] = useReducer(batchReducer, initialBatchState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const queue = useRef<BatchAction[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<AbortController | null>(null);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const actions = queue.current;
    queue.current = [];
    if (actions.length) dispatch({ type: 'many', actions });
  }, []);

  const enqueue = useCallback(
    (action: BatchAction) => {
      queue.current.push(action);
      timer.current ??= setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  const control = useCallback(
    (action: BatchAction) => {
      queue.current.push(action);
      flush();
    },
    [flush],
  );

  const execute = useCallback(
    async (plans: GroupPlan[], options: ProcessOptions) => {
      const controller = new AbortController();
      current.current = controller;
      const mine = () => current.current === controller;
      const end = await runGroups({
        api,
        groups: plans,
        options,
        signal: controller.signal,
        onGroupStart: (group) => mine() && control({ type: 'groupStart', group }),
        onEvent: (group, event) => mine() && enqueue({ type: 'event', group, event }),
        onGroupEnd: (group, outcome) => mine() && control({ type: 'groupEnd', group, outcome }),
      });
      if (!mine()) return;
      current.current = null;
      if (end !== 'cancelled') control({ type: 'finish', at: Date.now() });
    },
    [api, control, enqueue],
  );

  const start = useCallback(
    (items: NewItem[], options: ProcessOptions, limits: SplitLimits) => {
      current.current?.abort();
      current.current = null;
      queue.current = [];
      const { groups, plans } = plan(
        items.map((item, index) => ({ index, file: item.file })),
        limits,
      );
      control({ type: 'start', items, groups, at: Date.now() });
      return execute(plans, options);
    },
    [control, execute],
  );

  /** Sends again only the retryable items (errors worth retrying, interrupted, cancelled). */
  const retry = useCallback(
    (options: ProcessOptions, limits: SplitLimits) => {
      if (current.current) return Promise.resolve();
      const entries = stateRef.current.items
        .filter(isRetryable)
        .map((item) => ({ index: item.index, file: item.file }));
      if (entries.length === 0) return Promise.resolve();
      const { groups, plans } = plan(entries, limits);
      control({ type: 'retry', groups, at: Date.now() });
      return execute(plans, options);
    },
    [control, execute],
  );

  const cancel = useCallback(() => {
    if (!current.current) return;
    current.current.abort();
    current.current = null;
    control({ type: 'cancel', at: Date.now() });
  }, [control]);

  const reset = useCallback(() => {
    current.current?.abort();
    current.current = null;
    queue.current = [];
    clearTimeout(timer.current);
    timer.current = undefined;
    dispatch({ type: 'reset' });
  }, []);

  useEffect(
    () => () => {
      current.current?.abort();
      clearTimeout(timer.current);
    },
    [],
  );

  return { state, start, retry, cancel, reset };
}
