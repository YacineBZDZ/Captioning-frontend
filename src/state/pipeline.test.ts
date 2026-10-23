import { describe, expect, it } from 'vitest';
import { createApiClient, processImage, type ProcessOptions } from '../api/client';
import { createMockBackend, type ScenarioId } from '../mocks/mockBackend';
import { initialRunState, runReducer, type RunAction, type RunState } from './pipeline';

const OPTIONS: ProcessOptions = { denoise: 'auto', decoding: 'beam' };

/** Runs a mock scenario through the real client and the reducer, like the app does. */
async function run(scenario: ScenarioId, options = OPTIONS): Promise<RunState> {
  const mock = createMockBackend({ scenario, delay: () => 0, startupMs: 60_000 });
  const api = createApiClient('http://mock', mock.fetch);
  let state = runReducer(initialRunState, { type: 'start', at: 0 });
  const dispatch = (a: RunAction) => (state = runReducer(state, a));
  const file = new File([new Uint8Array(2048)], 'cat.jpg', { type: 'image/jpeg' });
  const outcome = await processImage({
    api,
    file,
    options,
    signal: new AbortController().signal,
    onEvent: (event) => dispatch({ type: 'event', event }),
  });
  if (outcome.type === 'failed') dispatch({ type: 'fail', error: outcome.error });
  if (outcome.type === 'cancelled') dispatch({ type: 'cancel' });
  dispatch({ type: 'streamEnded' });
  return state;
}

const statuses = (s: RunState) =>
  Object.fromEntries(Object.entries(s.steps).map(([k, v]) => [k, v.status]));

describe('runReducer driven by every mock scenario', () => {
  it('A: clean photo ends with a caption and denoising skipped', async () => {
    const s = await run('clean_photo');
    expect(s.phase).toBe('success');
    expect(s.result?.caption).toBe('a brown bear is standing in the grass');
    expect(statuses(s)).toEqual({
      validation: 'done',
      classification: 'done',
      quality: 'done',
      denoising: 'skipped',
      reclassification: 'not_needed',
      captioning: 'done',
    });
    expect(s.steps.denoising.data).toEqual({ applied: false, reason: 'clean' });
    expect(s.started?.filename).toBe('cat.jpg');
  });

  it('B: noisy photo applies denoising and captions the denoised image', async () => {
    const s = await run('noisy_photo');
    expect(s.phase).toBe('success');
    expect(s.steps.denoising.status).toBe('done');
    expect(s.steps.denoising.data).toMatchObject({ applied: true, width: 192 });
    expect(s.steps.captioning.data?.input).toBe('denoised');
  });

  it('honours denoise=never', async () => {
    const s = await run('noisy_photo', { denoise: 'never', decoding: 'greedy' });
    expect(s.steps.denoising.data).toEqual({ applied: false, reason: 'disabled_by_request' });
    expect(s.steps.captioning.data).toMatchObject({ input: 'original', decoding: 'greedy' });
  });

  it('D: misclassified noisy photo is rescued by reclassification', async () => {
    const s = await run('rescued_photo');
    expect(s.phase).toBe('success');
    expect(s.steps.classification.data?.is_photo).toBe(false);
    expect(s.steps.classification.status).toBe('done');
    expect(s.steps.reclassification.status).toBe('done');
    expect(s.steps.reclassification.data?.is_photo).toBe(true);
    expect(s.error).toBeUndefined();
  });

  it('C: clean painting fails with NOT_A_PHOTO on classification, not rechecked', async () => {
    const s = await run('clean_painting');
    expect(s.phase).toBe('error');
    expect(s.error).toMatchObject({ code: 'NOT_A_PHOTO', step: 'classification' });
    expect(s.error?.details).toMatchObject({ predicted_class: 'Painting', rechecked: false });
    expect(s.steps.classification.status).toBe('error');
    expect(s.steps.denoising.status).toBe('not_needed');
    expect(s.steps.captioning.status).toBe('not_needed');
    expect(s.result).toBeUndefined();
  });

  it('D: degraded painting fails with NOT_A_PHOTO on reclassification, rechecked', async () => {
    const s = await run('degraded_painting');
    expect(s.error).toMatchObject({ code: 'NOT_A_PHOTO', step: 'reclassification' });
    expect(s.error?.details?.rechecked).toBe(true);
    expect(s.steps.reclassification.status).toBe('error');
    expect(s.steps.denoising.status).toBe('done');
    expect(s.steps.captioning.status).toBe('not_needed');
  });

  it('invalid image fails on validation', async () => {
    const s = await run('invalid_image');
    expect(s.error).toMatchObject({ code: 'INVALID_IMAGE', step: 'validation' });
    expect(s.steps.validation.status).toBe('error');
    expect(s.steps.classification.status).toBe('not_needed');
  });

  it('file too large is an HTTP 413 error before the stream', async () => {
    const s = await run('file_too_large');
    expect(s.error).toMatchObject({ code: 'FILE_TOO_LARGE', httpStatus: 413 });
    expect(Object.values(statuses(s)).every((v) => v === 'not_needed')).toBe(true);
  });

  it('server busy carries Retry-After', async () => {
    const s = await run('server_busy');
    expect(s.error).toMatchObject({ code: 'SERVER_BUSY', httpStatus: 429, retryAfterS: 15 });
  });

  it('internal error highlights the failed step and keeps the request id', async () => {
    const s = await run('internal_error');
    expect(s.error).toMatchObject({ code: 'INTERNAL_ERROR', step: 'captioning' });
    expect(s.error?.requestId).toMatch(/^[0-9a-f]{8}$/);
    expect(s.steps.captioning.status).toBe('error');
    expect(s.steps.quality.status).toBe('done');
  });

  it('connection lost mid-stream becomes CONNECTION_LOST on the running step', async () => {
    const s = await run('connection_lost');
    expect(s.error?.code).toBe('CONNECTION_LOST');
    expect(s.steps.quality.status).toBe('error');
    expect(s.steps.classification.status).toBe('done');
  });

  it('server starting answers MODEL_NOT_READY', async () => {
    const s = await run('server_starting');
    expect(s.error).toMatchObject({ code: 'MODEL_NOT_READY', httpStatus: 503 });
  });

  it('server offline becomes SERVER_OFFLINE', async () => {
    const s = await run('server_offline');
    expect(s.error?.code).toBe('SERVER_OFFLINE');
  });
});

describe('runReducer rules', () => {
  const start = runReducer(initialRunState, { type: 'start', at: 0 });

  it('a stream ending without a terminal event is CONNECTION_LOST', () => {
    let s = runReducer(start, {
      type: 'event',
      event: { event: 'step', step: 'validation', status: 'running' },
    });
    s = runReducer(s, { type: 'streamEnded' });
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('CONNECTION_LOST');
    expect(s.steps.validation.status).toBe('error');
  });

  it('a stream ending after a terminal event changes nothing', () => {
    const s = runReducer(start, { type: 'event', event: { event: 'result', caption: 'x' } });
    expect(runReducer(s, { type: 'streamEnded' })).toBe(s);
  });

  it('only the terminal event ends a run: is_photo false keeps it running', () => {
    const s = runReducer(start, {
      type: 'event',
      event: {
        event: 'step',
        step: 'classification',
        status: 'done',
        data: {
          predicted_class: 'Painting',
          confidence: 0.6,
          probabilities: {},
          is_photo: false,
          photo_threshold: 0.5,
          input: 'original',
        },
      },
    });
    expect(s.phase).toBe('running');
  });

  it('cancel settles the run and ignores later events', () => {
    const s = runReducer(start, { type: 'cancel' });
    expect(s.phase).toBe('cancelled');
    expect(runReducer(s, { type: 'event', event: { event: 'result', caption: 'x' } })).toBe(s);
  });
});
