import type { AppError } from '../api/errors';
import {
  STEP_IDS,
  type ResultEvent,
  type StartedEvent,
  type StepDataMap,
  type StepId,
  type StreamEvent,
} from '../api/types';

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error' | 'not_needed';

export interface StepState<K extends StepId = StepId> {
  status: StepStatus;
  elapsedMs?: number;
  data?: StepDataMap[K];
}

export type Steps = { [K in StepId]: StepState<K> };

export type RunPhase = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

export interface RunState {
  phase: RunPhase;
  started?: StartedEvent;
  steps: Steps;
  result?: ResultEvent;
  error?: AppError;
  /** Wall-clock start of the run, for the client-side total when the server sends none. */
  startedAt?: number;
}

export type RunAction =
  | { type: 'start'; at: number }
  | { type: 'event'; event: StreamEvent }
  | { type: 'fail'; error: AppError }
  | { type: 'cancel' }
  /** The stream closed. Without a terminal event, that is CONNECTION_LOST. */
  | { type: 'streamEnded' }
  | { type: 'reset' };

function emptySteps(): Steps {
  const steps = {} as Record<StepId, StepState>;
  for (const id of STEP_IDS) steps[id] = { status: 'pending' };
  return steps as Steps;
}

export const initialRunState: RunState = { phase: 'idle', steps: emptySteps() };

/** Closes the timeline: unfinished steps become "not needed", or "error" for the failed one. */
function settle(steps: Steps, failedStep: StepId | undefined, failed: boolean): Steps {
  const next = { ...steps } as Record<StepId, StepState>;
  for (const id of STEP_IDS) {
    const s = next[id];
    if (failed && id === failedStep) {
      next[id] = { ...s, status: 'error' };
    } else if (s.status === 'pending') {
      next[id] = { ...s, status: 'not_needed' };
    } else if (s.status === 'running') {
      // A step interrupted by an error is where things went wrong.
      next[id] = { ...s, status: failed ? 'error' : 'not_needed' };
    }
  }
  return next as Steps;
}

function runningStep(steps: Steps): StepId | undefined {
  return STEP_IDS.find((id) => steps[id].status === 'running');
}

function isTerminal(phase: RunPhase): boolean {
  return phase !== 'running';
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'start':
      return { phase: 'running', steps: emptySteps(), startedAt: action.at };

    case 'reset':
      return initialRunState;

    case 'cancel':
      if (state.phase !== 'running') return state;
      return { ...state, phase: 'cancelled', steps: settle(state.steps, undefined, false) };

    case 'fail': {
      if (state.phase !== 'running') return state;
      const step = action.error.step ?? runningStep(state.steps);
      return {
        ...state,
        phase: 'error',
        error: {
          ...action.error,
          step,
          requestId: action.error.requestId ?? state.started?.request_id,
        },
        steps: settle(state.steps, step, true),
      };
    }

    case 'streamEnded':
      if (isTerminal(state.phase)) return state;
      return runReducer(state, { type: 'fail', error: { code: 'CONNECTION_LOST' } });

    case 'event':
      if (state.phase !== 'running') return state;
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: RunState, event: StreamEvent): RunState {
  switch (event.event) {
    case 'started':
      return { ...state, started: event };

    case 'step': {
      const prev = state.steps[event.step];
      const next: StepState =
        event.status === 'running'
          ? { status: 'running' }
          : { status: event.status, elapsedMs: event.elapsed_ms, data: event.data ?? prev.data };
      return { ...state, steps: { ...state.steps, [event.step]: next } };
    }

    case 'result':
      return {
        ...state,
        phase: 'success',
        result: event,
        steps: settle(state.steps, undefined, false),
      };

    case 'error': {
      const { event: _ignored, ...body } = event;
      void _ignored;
      return runReducer(state, {
        type: 'fail',
        error: {
          code: body.code,
          serverMessage: body.message,
          step: body.step,
          requestId: body.request_id,
          details: body.details,
        },
      });
    }
  }
}

// ---- Selectors -------------------------------------------------------------

/** Classification that decides: the reclassification if it ran, else the first one. */
export function finalClassification(state: RunState) {
  return (
    state.result?.classification ??
    state.steps.reclassification.data ??
    state.steps.classification.data
  );
}

export function denoisedImage(state: RunState): string | undefined {
  const d = state.steps.denoising.data;
  return d && d.applied ? d.image : undefined;
}
