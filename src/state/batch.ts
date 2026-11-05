// State of a batch run (API contract v1.1), across the groups of an
// auto-split selection. Every item holds the same ImageRun shape as the
// single-image flow, so the timeline renders both.

import type { GroupOutcome } from '../api/batchClient';
import { fromErrorBody, type AppError } from '../api/errors';
import {
  STAGE_IDS,
  STEP_IDS,
  type BatchItemResult,
  type BatchStreamEvent,
  type ClassificationData,
  type StageId,
  type StepId,
} from '../api/types';
import { emptySteps, settle, withStep, type ImageRun, type Steps } from './pipeline';

/** Final state of an item. `null` while it is still to be processed. */
export type ItemOutcome = 'done' | 'not_a_photo' | 'error' | 'cancelled' | 'interrupted';

export type ItemStatus =
  'waiting' | 'classifying' | 'checking' | 'cleaning' | 'rechecking' | 'captioning' | ItemOutcome;

export interface BatchItem {
  /** Position in the selection (global index, upload order). */
  index: number;
  id: string;
  file: File;
  url: string;
  filename: string;
  bytes: number;
  /** Group of the current attempt this item belongs to. */
  group: number;
  outcome: ItemOutcome | null;
  run: ImageRun;
  caption?: string;
  /** Classification that decided (reclassification if it ran). */
  classification?: ClassificationData;
  denoised: boolean;
  error?: AppError;
}

export interface BatchGroup {
  /** Global item indices, in the order the files were sent. */
  indices: number[];
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  requestId?: string;
}

export type BatchPhase = 'idle' | 'running' | 'finished' | 'cancelled';

export interface BatchState {
  phase: BatchPhase;
  items: BatchItem[];
  groups: BatchGroup[];
  currentGroup: number | null;
  /** Stages currently reported "running" by the server for the current group. */
  activeStages: StageId[];
  /** Server stage timings, summed over groups and attempts. */
  timings: Partial<Record<StageId, number>>;
  serverTotalMs: number;
  startedAt?: number;
  finishedAt?: number;
  /** Wall-clock time of previous attempts (before a retry). */
  elapsedBeforeMs: number;
  /** Batch-level failure of the last attempt (items keep their own errors). */
  error?: AppError;
}

export interface NewItem {
  id: string;
  file: File;
  url: string;
}

export type BatchAction =
  | { type: 'start'; items: NewItem[]; groups: number[][]; at: number }
  | { type: 'retry'; groups: number[][]; at: number }
  | { type: 'groupStart'; group: number }
  | { type: 'event'; group: number; event: BatchStreamEvent }
  | { type: 'groupEnd'; group: number; outcome: GroupOutcome }
  /** The group runner returned: whatever is still unfinished was not processed. */
  | { type: 'finish'; at: number }
  | { type: 'cancel'; at: number }
  | { type: 'reset' }
  /** Several actions applied in order (throttled rendering). */
  | { type: 'many'; actions: BatchAction[] };

export const initialBatchState: BatchState = {
  phase: 'idle',
  items: [],
  groups: [],
  currentGroup: null,
  activeStages: [],
  timings: {},
  serverTotalMs: 0,
  elapsedBeforeMs: 0,
};

/** Items whose failure is worth sending again. */
export const RETRYABLE_CODES = ['INTERNAL_ERROR', 'BATCH_TIMEOUT'];

export function isRetryable(item: BatchItem): boolean {
  if (item.outcome === 'cancelled' || item.outcome === 'interrupted') return true;
  return item.outcome === 'error' && RETRYABLE_CODES.includes(String(item.error?.code));
}

function freshRun(): ImageRun {
  return { phase: 'running', steps: emptySteps() };
}

function makeGroups(groups: number[][]): BatchGroup[] {
  return groups.map((indices) => ({ indices, status: 'pending' }));
}

function groupOf(groups: number[][], index: number): number {
  return groups.findIndex((g) => g.includes(index));
}

// ---- item transitions ------------------------------------------------------

function updateItem(state: BatchState, index: number, fn: (item: BatchItem) => BatchItem) {
  const item = state.items[index];
  if (!item) return state;
  const next = fn(item);
  if (next === item) return state;
  const items = state.items.slice();
  items[index] = next;
  return { ...state, items };
}

/** The step a failure belongs to when the server does not name one. */
function failedStepOf(steps: Steps): StepId {
  if (steps.validation.status === 'pending') return 'validation';
  return (
    STEP_IDS.find((id) => steps[id].status === 'running') ??
    STEP_IDS.find((id) => steps[id].status === 'pending') ??
    'captioning'
  );
}

function decidingClassification(steps: Steps): ClassificationData | undefined {
  return steps.reclassification.data ?? steps.classification.data;
}

function finishItem(item: BatchItem, result: BatchItemResult): BatchItem {
  if (item.outcome) return item; // idempotent: the first item_done wins
  if (result.status === 'ok') {
    let steps = item.run.steps;
    if (steps.captioning.status === 'pending' || steps.captioning.status === 'running')
      steps = withStep(steps, 'captioning', 'done');
    const classification = result.classification ?? decidingClassification(steps);
    const denoising = steps.denoising.data;
    return {
      ...item,
      outcome: 'done',
      caption: result.caption,
      classification,
      denoised: result.denoising?.applied ?? (denoising ? denoising.applied : false),
      run: { phase: 'success', steps: settle(steps, undefined, false) },
    };
  }
  const error = fromErrorBody(result.error);
  const step = error.step ?? failedStepOf(item.run.steps);
  const details = error.details;
  const fromDetails =
    error.code === 'NOT_A_PHOTO' && typeof details?.predicted_class === 'string'
      ? (details as unknown as ClassificationData)
      : undefined;
  return {
    ...item,
    outcome: error.code === 'NOT_A_PHOTO' ? 'not_a_photo' : 'error',
    error: { ...error, step },
    caption: undefined,
    classification: decidingClassification(item.run.steps) ?? fromDetails,
    run: { phase: 'error', steps: settle(item.run.steps, step, true), error: { ...error, step } },
  };
}

/** Closes an unfinished item without a server verdict. Unreached steps stay pending. */
function abandonItem(item: BatchItem, outcome: 'cancelled' | 'interrupted', error?: AppError) {
  if (item.outcome) return item;
  const steps = { ...item.run.steps } as Record<StepId, Steps[StepId]>;
  for (const id of STEP_IDS) if (steps[id].status === 'running') steps[id] = { status: 'pending' };
  return {
    ...item,
    outcome,
    error,
    run: { phase: 'cancelled' as const, steps: steps as Steps, error },
  };
}

function abandonWhere(
  state: BatchState,
  predicate: (item: BatchItem) => boolean,
  outcome: 'cancelled' | 'interrupted',
  error?: AppError,
): BatchState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.outcome || !predicate(item)) return item;
    changed = true;
    return abandonItem(item, outcome, error);
  });
  return changed ? { ...state, items } : state;
}

// ---- events ----------------------------------------------------------------

function applyEvent(state: BatchState, group: number, event: BatchStreamEvent): BatchState {
  const g = state.groups[group];
  if (!g) return state;
  const globalIndex = (serverIndex: number) => g.indices[serverIndex];

  switch (event.event) {
    case 'batch_started': {
      let next: BatchState = {
        ...state,
        groups: state.groups.map((x, i) =>
          i === group ? { ...x, requestId: event.request_id } : x,
        ),
      };
      for (const it of event.items) {
        const index = globalIndex(it.index);
        if (index === undefined) continue;
        if (it.status === 'rejected') {
          next = updateItem(next, index, (item) =>
            finishItem(item, {
              index: it.index,
              status: 'error',
              error: { step: 'validation', ...(it.error ?? { code: 'INVALID_IMAGE' }) },
            }),
          );
        } else {
          next = updateItem(next, index, (item) =>
            item.outcome
              ? item
              : {
                  ...item,
                  run: {
                    ...item.run,
                    steps: withStep(item.run.steps, 'validation', 'done', {
                      width: it.width ?? 0,
                      height: it.height ?? 0,
                      format: it.format ?? '',
                      bytes: it.bytes ?? item.bytes,
                    }),
                  },
                },
          );
        }
      }
      return next;
    }

    case 'stage': {
      if (event.status === 'running') {
        if (state.activeStages.includes(event.stage)) return state;
        return { ...state, activeStages: [...state.activeStages, event.stage] };
      }
      const timings =
        typeof event.elapsed_ms === 'number'
          ? {
              ...state.timings,
              [event.stage]: (state.timings[event.stage] ?? 0) + event.elapsed_ms,
            }
          : state.timings;
      return {
        ...state,
        timings,
        activeStages: state.activeStages.filter((s) => s !== event.stage),
      };
    }

    case 'item_step': {
      const index = globalIndex(event.index);
      if (index === undefined) return state;
      return updateItem(state, index, (item) =>
        item.outcome
          ? item
          : {
              ...item,
              run: {
                ...item.run,
                steps: withStep(item.run.steps, event.step, event.status, event.data),
              },
            },
      );
    }

    case 'item_done': {
      const index = globalIndex(event.index);
      if (index === undefined) return state;
      return updateItem(state, index, (item) => finishItem(item, event));
    }

    case 'batch_result': {
      // Reconcile: anything we missed is taken from the summary.
      let next = state;
      for (const r of event.items) {
        const index = globalIndex(r.index);
        if (index !== undefined) next = updateItem(next, index, (item) => finishItem(item, r));
      }
      return {
        ...next,
        serverTotalMs: next.serverTotalMs + (event.total_ms ?? 0),
        groups: next.groups.map((x, i) => (i === group ? { ...x, status: 'done' } : x)),
      };
    }

    case 'heartbeat':
    case 'error': // batch-level errors arrive as a group outcome, see groupEnd
    default:
      return state;
  }
}

// ---- reducer ---------------------------------------------------------------

export function batchReducer(state: BatchState, action: BatchAction): BatchState {
  switch (action.type) {
    case 'many':
      return action.actions.reduce(batchReducer, state);

    case 'reset':
      return initialBatchState;

    case 'start':
      return {
        ...initialBatchState,
        phase: 'running',
        startedAt: action.at,
        groups: makeGroups(action.groups),
        items: action.items.map((n, index) => ({
          index,
          id: n.id,
          file: n.file,
          url: n.url,
          filename: n.file.name,
          bytes: n.file.size,
          group: groupOf(action.groups, index),
          outcome: null,
          run: freshRun(),
          denoised: false,
        })),
      };

    case 'retry': {
      if (state.phase === 'running') return state;
      const retried = new Set(action.groups.flat());
      const previous =
        state.startedAt !== undefined && state.finishedAt !== undefined
          ? state.finishedAt - state.startedAt
          : 0;
      return {
        ...state,
        phase: 'running',
        startedAt: action.at,
        finishedAt: undefined,
        elapsedBeforeMs: state.elapsedBeforeMs + previous,
        error: undefined,
        groups: makeGroups(action.groups),
        currentGroup: null,
        activeStages: [],
        items: state.items.map((item) =>
          retried.has(item.index)
            ? {
                ...item,
                group: groupOf(action.groups, item.index),
                outcome: null,
                run: freshRun(),
                caption: undefined,
                classification: undefined,
                denoised: false,
                error: undefined,
              }
            : { ...item, group: -1 },
        ),
      };
    }

    case 'groupStart':
      if (state.phase !== 'running') return state;
      return {
        ...state,
        currentGroup: action.group,
        activeStages: [],
        groups: state.groups.map((g, i) => (i === action.group ? { ...g, status: 'running' } : g)),
      };

    case 'event':
      if (state.phase !== 'running') return state;
      return applyEvent(state, action.group, action.event);

    case 'groupEnd': {
      if (state.phase !== 'running') return state;
      const { group, outcome } = action;
      const inGroup = (item: BatchItem) => item.group === group;
      if (outcome.type === 'completed') {
        // Every item should have had its item_done; anything left was lost.
        const lost = abandonWhere(state, inGroup, 'interrupted', { code: 'CONNECTION_LOST' });
        return {
          ...lost,
          activeStages: [],
          groups: lost.groups.map((g, i) => (i === group ? { ...g, status: 'done' } : g)),
        };
      }
      if (outcome.type === 'cancelled') return state; // handled by 'cancel'
      const failed = abandonWhere(state, inGroup, 'interrupted', outcome.error);
      return {
        ...failed,
        error: outcome.error,
        activeStages: [],
        groups: failed.groups.map((g, i) => (i === group ? { ...g, status: 'failed' } : g)),
      };
    }

    case 'finish': {
      if (state.phase !== 'running') return state;
      // Groups never sent (after a batch-level failure) are not processed.
      const rest = abandonWhere(
        state,
        (item) => item.group >= 0,
        'interrupted',
        state.error ?? { code: 'CONNECTION_LOST' },
      );
      return {
        ...rest,
        phase: 'finished',
        finishedAt: action.at,
        currentGroup: null,
        activeStages: [],
      };
    }

    case 'cancel': {
      if (state.phase !== 'running') return state;
      const cancelled = abandonWhere(state, (item) => item.group >= 0, 'cancelled');
      return {
        ...cancelled,
        phase: 'cancelled',
        finishedAt: action.at,
        currentGroup: null,
        activeStages: [],
        groups: cancelled.groups.map((g) =>
          g.status === 'running' || g.status === 'pending' ? { ...g, status: 'cancelled' } : g,
        ),
      };
    }
  }
}

// ---- selectors -------------------------------------------------------------

const STAGE_STATUS: Record<StageId, ItemStatus> = {
  classification: 'classifying',
  quality: 'checking',
  denoising: 'cleaning',
  reclassification: 'rechecking',
  captioning: 'captioning',
};

/** The next stage this item will go through, given what it has done so far. */
function nextStage(steps: Steps): StageId | undefined {
  for (const stage of STAGE_IDS) {
    const s = steps[stage].status;
    if (s === 'done' || s === 'skipped') continue;
    if (stage === 'reclassification' && steps.classification.data?.is_photo !== false) continue;
    return stage;
  }
  return undefined;
}

export function itemStatus(item: BatchItem, state: BatchState): ItemStatus {
  if (item.outcome) return item.outcome;
  if (state.phase !== 'running' || item.group !== state.currentGroup) return 'waiting';
  if (item.run.steps.validation.status !== 'done') return 'waiting';
  const stage = nextStage(item.run.steps);
  return stage && state.activeStages.includes(stage) ? STAGE_STATUS[stage] : 'waiting';
}

export type StripStage = 'upload' | StageId;
export const STRIP_STAGES: StripStage[] = ['upload', ...STAGE_IDS];

/** Images that passed each stage (done or skipped). */
export function stageCounts(state: BatchState): Record<StripStage, number> {
  const counts = { upload: 0 } as Record<StripStage, number>;
  for (const s of STAGE_IDS) counts[s] = 0;
  for (const item of state.items) {
    const steps = item.run.steps;
    if (steps.validation.status === 'done') counts.upload++;
    for (const s of STAGE_IDS) {
      if (steps[s].status === 'done' || steps[s].status === 'skipped') counts[s]++;
    }
  }
  return counts;
}

export interface BatchSummary {
  total: number;
  finished: number;
  captioned: number;
  notPhotos: number;
  errors: number;
  cancelled: number;
  interrupted: number;
  retryable: number;
}

export function summarise(state: BatchState): BatchSummary {
  const s: BatchSummary = {
    total: state.items.length,
    finished: 0,
    captioned: 0,
    notPhotos: 0,
    errors: 0,
    cancelled: 0,
    interrupted: 0,
    retryable: 0,
  };
  for (const item of state.items) {
    if (item.outcome) s.finished++;
    if (item.outcome === 'done') s.captioned++;
    if (item.outcome === 'not_a_photo') s.notPhotos++;
    if (item.outcome === 'error') s.errors++;
    if (item.outcome === 'cancelled') s.cancelled++;
    if (item.outcome === 'interrupted') s.interrupted++;
    if (isRetryable(item)) s.retryable++;
  }
  return s;
}

/** Items that received a server verdict (item_done), for the progress bar. */
export function processedCount(state: BatchState): number {
  return state.items.filter(
    (i) => i.outcome === 'done' || i.outcome === 'not_a_photo' || i.outcome === 'error',
  ).length;
}
