import { describe, expect, it } from 'vitest';
import { createMockBackend, mockCaptionFor, type ScenarioId } from '../mocks/mockBackend';
import { batchReducer, initialBatchState, type BatchAction, type BatchState } from '../state/batch';
import { splitIntoGroups, splitLimits } from '../state/batchSplit';
import { processBatch, runGroups, type GroupPlan } from './batchClient';
import { createApiClient, type FetchFn } from './client';
import type { BatchStreamEvent } from './types';

const OPTIONS = { denoise: 'auto', decoding: 'beam' } as const;

function jpeg(name: string, size = 1024) {
  return new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
}

/** Mock backend whose fetch records the file names of every /v1/batch request. */
function recordingMock(scenario: ScenarioId, delay: () => number = () => 0) {
  const mock = createMockBackend({ scenario, delay });
  const requests: string[][] = [];
  const fetchFn: FetchFn = (input, init) => {
    if (input.includes('/v1/batch') && init?.body instanceof FormData) {
      requests.push(init.body.getAll('files').map((f) => (f as File).name));
    }
    return mock.fetch(input, init);
  };
  return { api: createApiClient('http://mock.local', fetchFn), requests };
}

/** Runs files through the splitter, the group runner and the reducer, like useBatchRun. */
async function runAll(
  files: File[],
  scenario: ScenarioId,
  hooks: { onEvent?: (e: BatchStreamEvent, abort: () => void) => void } = {},
) {
  const { api, requests } = recordingMock(scenario);
  const indices = splitIntoGroups(
    files.map((f, i) => ({ i, size: f.size })),
    (x) => x.size,
    splitLimits({ maxImages: 20, maxTotalMb: 60 }),
  ).map((g) => g.map((x) => x.i));
  let state: BatchState = batchReducer(initialBatchState, {
    type: 'start',
    at: 0,
    groups: indices,
    items: files.map((file, i) => ({ id: String(i), file, url: `blob:${i}` })),
  });
  const dispatch = (a: BatchAction) => (state = batchReducer(state, a));
  const controller = new AbortController();
  const plans: GroupPlan[] = indices.map((g) => ({ indices: g, files: g.map((i) => files[i]!) }));
  const end = await runGroups({
    api,
    groups: plans,
    options: OPTIONS,
    signal: controller.signal,
    onGroupStart: (group) => dispatch({ type: 'groupStart', group }),
    onEvent: (group, event) => {
      dispatch({ type: 'event', group, event });
      hooks.onEvent?.(event, () => {
        controller.abort();
        dispatch({ type: 'cancel', at: 1 });
      });
    },
    onGroupEnd: (group, outcome) => dispatch({ type: 'groupEnd', group, outcome }),
  });
  dispatch({ type: 'finish', at: 2 });
  return { state, requests, end };
}

describe('batch client against the mock backend', () => {
  it('sends 45 files as 3 consecutive requests and merges them in the original order', async () => {
    const files = Array.from({ length: 45 }, (_, i) => jpeg(`photo-${i + 1}.jpg`));
    const { state, requests, end } = await runAll(files, 'batch_45');
    expect(end).toBe('completed');
    expect(requests.map((r) => r.length)).toEqual([20, 20, 5]);
    expect(requests.flat()).toEqual(files.map((f) => f.name));
    expect(state.phase).toBe('finished');
    expect(state.items.every((i) => i.outcome === 'done')).toBe(true);
    expect(state.items.map((i) => i.caption)).toEqual(files.map((f) => mockCaptionFor(f.name)));
    expect(state.groups.map((g) => g.status)).toEqual(['done', 'done', 'done']);
  });

  it('runs the mixed batch: captions, not-photos and an invalid file', async () => {
    const names = [
      'photo.jpg',
      'painting.jpg',
      'degraded-painting.jpg',
      'noisy-street.jpg',
      'rescue-beach.jpg',
      'bad-file.jpg',
    ];
    const { state } = await runAll(
      names.map((n) => jpeg(n)),
      'batch_mixed',
    );
    expect(state.items.map((i) => i.outcome)).toEqual([
      'done',
      'not_a_photo',
      'not_a_photo',
      'done',
      'done',
      'error',
    ]);
    expect(state.items[2]!.error?.details?.rechecked).toBe(true);
    expect(state.items[2]!.error?.step).toBe('reclassification');
    expect(state.items[3]!.denoised).toBe(true);
    expect(state.items[4]!.run.steps.reclassification.data?.is_photo).toBe(true);
    expect(state.items[5]!.error?.code).toBe('INVALID_IMAGE');
    expect(state.items.filter((i) => i.outcome !== 'done').every((i) => !i.caption)).toBe(true);
  });

  it('cancel keeps the finished items', async () => {
    const files = Array.from({ length: 12 }, (_, i) => jpeg(`photo-${i + 1}.jpg`));
    let captions = 0;
    const { state, end } = await runAll(files, 'batch_clean_12', {
      onEvent: (e, abort) => {
        if (e.event === 'item_done' && ++captions === 3) abort();
      },
    });
    expect(end).toBe('cancelled');
    expect(state.phase).toBe('cancelled');
    const outcomes = state.items.map((i) => i.outcome);
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'cancelled')).toHaveLength(9);
    expect(state.items.filter((i) => i.outcome === 'done').every((i) => i.caption)).toBe(true);
  });

  it('connection lost mid-batch keeps finished items and interrupts the rest', async () => {
    const files = Array.from({ length: 8 }, (_, i) => jpeg(`photo-${i + 1}.jpg`));
    const { state, end } = await runAll(files, 'batch_connection_lost');
    expect(end).toBe('stopped');
    expect(state.error?.code).toBe('CONNECTION_LOST');
    expect(state.items.filter((i) => i.outcome === 'done')).toHaveLength(3); // one micro-batch
    expect(state.items.filter((i) => i.outcome === 'interrupted')).toHaveLength(5);
  });
});

describe('processBatch', () => {
  it('posts the files under "files" with the options, to /v1/batch', async () => {
    let seen: { url: string; form: FormData } | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url, form: init!.body as FormData };
      return new Response('{"event":"batch_result","items":[]}\n', { status: 200 });
    };
    const out = await processBatch({
      api: createApiClient('http://x', fetchFn),
      files: [jpeg('a.jpg'), jpeg('b.jpg')],
      options: { denoise: 'never', decoding: 'greedy' },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(out).toEqual({ type: 'completed' });
    expect(seen!.url).toBe('http://x/v1/batch?stream=true');
    expect(seen!.form.getAll('files').map((f) => (f as File).name)).toEqual(['a.jpg', 'b.jpg']);
    expect(seen!.form.get('denoise')).toBe('never');
    expect(seen!.form.get('decoding')).toBe('greedy');
  });

  it('returns an in-stream error event as a failed outcome with the request id', async () => {
    const events: string[] = [];
    const fetchFn: FetchFn = async () =>
      new Response(
        '{"event":"batch_started","request_id":"r1","count":0,"items":[]}\n{"event":"error","code":"INTERNAL_ERROR","message":"boom","request_id":"r1"}\n',
        { status: 200, headers: { 'X-Request-ID': 'r1' } },
      );
    const out = await processBatch({
      api: createApiClient('http://x', fetchFn),
      files: [jpeg('a.jpg')],
      options: OPTIONS,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e.event),
    });
    expect(out).toMatchObject({
      type: 'failed',
      error: { code: 'INTERNAL_ERROR', requestId: 'r1' },
    });
    expect(events).toEqual(['batch_started']);
  });

  it.each([
    ['batch_busy', 6, { code: 'SERVER_BUSY', httpStatus: 429, retryAfterS: 10 }],
    [
      'batch_too_many',
      8,
      { code: 'TOO_MANY_FILES', httpStatus: 413, details: { max_images: 5, received: 8 } },
    ],
    ['old_backend', 2, { code: 'HTTP_ERROR', httpStatus: 404 }],
    ['server_offline', 2, { code: 'SERVER_OFFLINE' }],
  ] as const)('maps the pre-stream failure of %s', async (scenario, n, error) => {
    const { api } = recordingMock(scenario);
    const out = await processBatch({
      api,
      files: Array.from({ length: n }, (_, i) => jpeg(`p${i}.jpg`)),
      options: OPTIONS,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(out).toMatchObject({ type: 'failed', error });
  });

  it('heartbeats keep the request alive; silence after them is a TIMEOUT', async () => {
    const { api } = recordingMock('batch_heartbeat_timeout', () => 40);
    const seen: string[] = [];
    const t0 = Date.now();
    const out = await processBatch({
      api,
      files: [jpeg('a.jpg'), jpeg('b.jpg')],
      options: OPTIONS,
      signal: new AbortController().signal,
      watchdogMs: 150,
      onEvent: (e) => seen.push(e.event),
    });
    expect(out).toMatchObject({ type: 'failed', error: { code: 'TIMEOUT' } });
    expect(seen.filter((e) => e === 'heartbeat')).toHaveLength(5);
    // 5 heartbeats 40 ms apart kept a 150 ms watchdog from firing early.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5 * 40 + 150);
  });
});
