import { describe, expect, it } from 'vitest';
import type { BatchStreamEvent, ClassificationData } from '../api/types';
import {
  batchReducer,
  initialBatchState,
  isRetryable,
  itemStatus,
  processedCount,
  stageCounts,
  summarise,
  type BatchAction,
  type BatchState,
} from './batch';

const photo: ClassificationData = {
  predicted_class: 'Photo',
  confidence: 0.97,
  probabilities: { Painting: 0.01, Photo: 0.97, Schematics: 0, Sketch: 0.01, Text: 0.01 },
  is_photo: true,
  photo_threshold: 0.5,
  input: 'original',
};
const painting: ClassificationData = {
  ...photo,
  predicted_class: 'Painting',
  confidence: 0.93,
  is_photo: false,
};

function file(name: string) {
  return new File([new Uint8Array(100)], name, { type: 'image/jpeg' });
}

function started(n: number, groups: number[][] = [[...Array(n).keys()]]): BatchState {
  return batchReducer(initialBatchState, {
    type: 'start',
    at: 1000,
    groups,
    items: Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      file: file(`img-${i}.jpg`),
      url: `blob:${i}`,
    })),
  });
}

const ev = (group: number, event: BatchStreamEvent): BatchAction => ({
  type: 'event',
  group,
  event,
});
const apply = (s: BatchState, ...actions: BatchAction[]) => actions.reduce(batchReducer, s);

const batchStarted = (n: number, rejected: number[] = []): BatchStreamEvent => ({
  event: 'batch_started',
  request_id: 'req1',
  count: n,
  items: Array.from({ length: n }, (_, index) =>
    rejected.includes(index)
      ? {
          index,
          filename: `img-${index}.jpg`,
          bytes: 100,
          status: 'rejected' as const,
          error: { code: 'INVALID_IMAGE', message: 'cannot decode' },
        }
      : {
          index,
          filename: `img-${index}.jpg`,
          bytes: 100,
          width: 640,
          height: 480,
          format: 'JPEG',
          status: 'accepted' as const,
        },
  ),
});

const ok = (index: number, caption = `caption ${index}`): BatchStreamEvent => ({
  event: 'item_done',
  index,
  status: 'ok',
  caption,
  classification: photo,
  denoising: { applied: false },
});

describe('batchReducer events', () => {
  it('start creates waiting items in upload order with their groups', () => {
    const s = started(3, [[0, 1], [2]]);
    expect(s.phase).toBe('running');
    expect(s.items.map((i) => [i.filename, i.group, i.outcome])).toEqual([
      ['img-0.jpg', 0, null],
      ['img-1.jpg', 0, null],
      ['img-2.jpg', 1, null],
    ]);
    expect(s.groups.map((g) => g.status)).toEqual(['pending', 'pending']);
  });

  it('batch_started fills validation data and finishes rejected items', () => {
    let s = apply(started(2), { type: 'groupStart', group: 0 }, ev(0, batchStarted(2, [1])));
    expect(s.groups[0]!.requestId).toBe('req1');
    expect(s.items[0]!.run.steps.validation).toMatchObject({
      status: 'done',
      data: { width: 640, height: 480, format: 'JPEG' },
    });
    expect(s.items[1]!.outcome).toBe('error');
    expect(s.items[1]!.error?.code).toBe('INVALID_IMAGE');
    expect(s.items[1]!.run.steps.validation.status).toBe('error');
    // The item_done that follows a rejection is a duplicate and is ignored.
    s = apply(s, ev(0, { event: 'item_done', index: 1, status: 'error', error: { code: 'X' } }));
    expect(s.items[1]!.error?.code).toBe('INVALID_IMAGE');
  });

  it('stage events drive the running stages, statuses and timings', () => {
    let s = apply(started(2), { type: 'groupStart', group: 0 }, ev(0, batchStarted(2)));
    expect(itemStatus(s.items[0]!, s)).toBe('waiting');
    s = apply(s, ev(0, { event: 'stage', stage: 'classification', status: 'running', count: 2 }));
    expect(s.activeStages).toEqual(['classification']);
    expect(itemStatus(s.items[0]!, s)).toBe('classifying');
    s = apply(
      s,
      ev(0, { event: 'item_step', index: 0, step: 'classification', status: 'done', data: photo }),
    );
    // Item 0 is past classification; quality has not started yet.
    expect(itemStatus(s.items[0]!, s)).toBe('waiting');
    expect(itemStatus(s.items[1]!, s)).toBe('classifying');
    s = apply(
      s,
      ev(0, { event: 'stage', stage: 'classification', status: 'done', count: 2, elapsed_ms: 88 }),
    );
    expect(s.activeStages).toEqual([]);
    expect(s.timings.classification).toBe(88);
    expect(stageCounts(s)).toMatchObject({ upload: 2, classification: 1, quality: 0 });
  });

  it('item_step data lands in the shared ImageRun shape', () => {
    const s = apply(
      started(1),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(1)),
      ev(0, {
        event: 'item_step',
        index: 0,
        step: 'classification',
        status: 'done',
        data: painting,
      }),
      ev(0, {
        event: 'item_step',
        index: 0,
        step: 'denoising',
        status: 'skipped',
        data: { applied: false, reason: 'clean' },
      }),
    );
    const run = s.items[0]!.run;
    expect(run.phase).toBe('running');
    expect(run.steps.classification).toEqual({ status: 'done', data: painting });
    expect(run.steps.denoising.status).toBe('skipped');
    expect(stageCounts(s).denoising).toBe(1);
  });

  it('item_done ok sets caption, final classification and denoised flag', () => {
    const s = apply(
      started(1),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(1)),
      ev(0, {
        event: 'item_step',
        index: 0,
        step: 'denoising',
        status: 'done',
        data: { applied: true, model: 'unet_mixed', image: 'data:x', width: 192, height: 192 },
      }),
      ev(0, { ...ok(0, 'a dog'), denoising: { applied: true } } as BatchStreamEvent),
    );
    const item = s.items[0]!;
    expect(item.outcome).toBe('done');
    expect(item.caption).toBe('a dog');
    expect(item.classification?.predicted_class).toBe('Photo');
    expect(item.denoised).toBe(true);
    expect(item.run.phase).toBe('success');
    expect(item.run.steps.captioning.status).toBe('done');
    expect(item.run.steps.reclassification.status).toBe('not_needed');
  });

  it('item_done NOT_A_PHOTO is a "not a photo" outcome with no caption', () => {
    const s = apply(
      started(1),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(1)),
      ev(0, {
        event: 'item_step',
        index: 0,
        step: 'classification',
        status: 'done',
        data: painting,
      }),
      ev(0, {
        event: 'item_done',
        index: 0,
        status: 'error',
        error: {
          code: 'NOT_A_PHOTO',
          step: 'classification',
          message: '…',
          details: { ...painting, rechecked: false },
        },
      }),
    );
    const item = s.items[0]!;
    expect(item.outcome).toBe('not_a_photo');
    expect(item.caption).toBeUndefined();
    expect(item.classification?.predicted_class).toBe('Painting');
    expect(item.run.steps.classification.status).toBe('error');
    expect(isRetryable(item)).toBe(false);
  });

  it('accepts events interleaved across images (no order between images)', () => {
    const s = apply(
      started(3),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(3)),
      ev(0, { event: 'item_step', index: 2, step: 'classification', status: 'done', data: photo }),
      ev(0, ok(2)),
      ev(0, { event: 'item_step', index: 0, step: 'classification', status: 'done', data: photo }),
      ev(0, ok(1)),
      ev(0, ok(0)),
    );
    expect(s.items.map((i) => i.caption)).toEqual(['caption 0', 'caption 1', 'caption 2']);
    expect(processedCount(s)).toBe(3);
  });

  it('ignores a duplicate item_done', () => {
    const once = apply(
      started(1),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(1)),
      ev(0, ok(0, 'first')),
    );
    const twice = apply(once, ev(0, ok(0, 'second')));
    expect(twice.items[0]!.caption).toBe('first');
    expect(twice.items).toBe(once.items);
  });

  it('ignores heartbeats and unknown events', () => {
    const s = apply(started(1), { type: 'groupStart', group: 0 }, ev(0, batchStarted(1)));
    expect(apply(s, ev(0, { event: 'heartbeat', t: 12 }))).toBe(s);
    expect(apply(s, ev(0, { event: 'whatever' } as unknown as BatchStreamEvent))).toBe(s);
    expect(apply(s, ev(0, { event: 'item_done', index: 99, status: 'ok', caption: 'x' }))).toBe(s);
  });

  it('batch_result fills in any item whose item_done was missed', () => {
    const s = apply(
      started(2),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(2)),
      ev(0, ok(0)),
      ev(0, {
        event: 'batch_result',
        request_id: 'req1',
        total_ms: 1900,
        items: [
          { index: 0, status: 'ok', caption: 'ignored, already done' },
          { index: 1, status: 'ok', caption: 'from summary' },
        ],
      }),
    );
    expect(s.items.map((i) => i.caption)).toEqual(['caption 0', 'from summary']);
    expect(s.serverTotalMs).toBe(1900);
    expect(s.groups[0]!.status).toBe('done');
  });
});

describe('batchReducer groups, failures and cancel', () => {
  it('maps server indices to global indices with the group offset', () => {
    const groups = [
      [...Array(20).keys()],
      [...Array(20).keys()].map((i) => i + 20),
      [40, 41, 42, 43, 44],
    ];
    let s = started(45, groups);
    s = apply(
      s,
      { type: 'groupStart', group: 1 },
      ev(1, batchStarted(20)),
      ev(1, ok(3, 'twenty-three')),
    );
    expect(s.items[23]!.caption).toBe('twenty-three');
    expect(s.items[3]!.caption).toBeUndefined();
    s = apply(s, { type: 'groupStart', group: 2 }, ev(2, ok(4, 'last')));
    expect(s.items[44]!.caption).toBe('last');
    expect(itemStatus(s.items[0]!, s)).toBe('waiting');
  });

  it('connection lost: unfinished items become Interrupted and retryable, finished kept', () => {
    let s = apply(
      started(3),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(3)),
      ev(0, ok(0)),
    );
    s = apply(
      s,
      {
        type: 'groupEnd',
        group: 0,
        outcome: { type: 'failed', error: { code: 'CONNECTION_LOST' } },
      },
      { type: 'finish', at: 5000 },
    );
    expect(s.phase).toBe('finished');
    expect(s.error?.code).toBe('CONNECTION_LOST');
    expect(s.items.map((i) => i.outcome)).toEqual(['done', 'interrupted', 'interrupted']);
    expect(s.items[0]!.caption).toBe('caption 0');
    expect(s.items.map(isRetryable)).toEqual([false, true, true]);
    expect(summarise(s)).toMatchObject({ captioned: 1, interrupted: 2, retryable: 2 });
  });

  it('a failing group keeps the results of finished groups and stops the later ones', () => {
    let s = started(4, [[0, 1], [2], [3]]);
    s = apply(
      s,
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(2)),
      ev(0, ok(0)),
      ev(0, ok(1)),
    );
    s = apply(s, { type: 'groupEnd', group: 0, outcome: { type: 'completed' } });
    s = apply(s, { type: 'groupStart', group: 1 });
    s = apply(s, {
      type: 'groupEnd',
      group: 1,
      outcome: { type: 'failed', error: { code: 'SERVER_BUSY', retryAfterS: 10 } },
    });
    s = apply(s, { type: 'finish', at: 2000 });
    expect(s.items.map((i) => i.outcome)).toEqual(['done', 'done', 'interrupted', 'interrupted']);
    expect(s.groups.map((g) => g.status)).toEqual(['done', 'failed', 'pending']);
    expect(s.error).toMatchObject({ code: 'SERVER_BUSY', retryAfterS: 10 });
  });

  it('BATCH_TIMEOUT and INTERNAL_ERROR items are retryable, invalid files are not', () => {
    const s = apply(
      started(3),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(3, [2])),
      ev(0, { event: 'item_done', index: 0, status: 'error', error: { code: 'BATCH_TIMEOUT' } }),
      ev(0, { event: 'item_done', index: 1, status: 'error', error: { code: 'INTERNAL_ERROR' } }),
    );
    expect(s.items.map(isRetryable)).toEqual([true, true, false]);
  });

  it('cancel keeps finished items and marks the rest Cancelled', () => {
    let s = apply(
      started(3, [[0, 1], [2]]),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(2)),
      ev(0, ok(0)),
    );
    s = apply(s, { type: 'cancel', at: 3000 });
    expect(s.phase).toBe('cancelled');
    expect(s.items.map((i) => i.outcome)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(s.items[0]!.caption).toBe('caption 0');
    // Late events after cancel are ignored.
    expect(apply(s, ev(0, ok(1)))).toBe(s);
    expect(apply(s, { type: 'finish', at: 4000 })).toBe(s);
  });

  it('retry re-runs only the given items and keeps the others', () => {
    let s = apply(
      started(3),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(3)),
      ev(0, ok(0)),
    );
    s = apply(s, { type: 'cancel', at: 3000 });
    s = apply(s, { type: 'retry', groups: [[1, 2]], at: 4000 });
    expect(s.phase).toBe('running');
    expect(s.elapsedBeforeMs).toBe(2000);
    expect(s.items.map((i) => [i.outcome, i.group])).toEqual([
      ['done', -1],
      [null, 0],
      [null, 0],
    ]);
    s = apply(
      s,
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(2)),
      ev(0, ok(1, 'one')),
      ev(0, ok(0, 'zero')),
    );
    // In the retry group, server index 0 is global item 1 and index 1 is item 2.
    expect(s.items.map((i) => i.caption)).toEqual(['caption 0', 'zero', 'one']);
  });
});

describe('stageCounts', () => {
  it('counts a "not a photo" image as having gone through classification', () => {
    const s = apply(
      started(2),
      { type: 'groupStart', group: 0 },
      ev(0, batchStarted(2)),
      ev(0, {
        event: 'item_step',
        index: 0,
        step: 'classification',
        status: 'done',
        data: painting,
      }),
      ev(0, { event: 'item_step', index: 1, step: 'classification', status: 'done', data: photo }),
      ev(0, {
        event: 'item_done',
        index: 0,
        status: 'error',
        error: { code: 'NOT_A_PHOTO', step: 'classification', details: { ...painting } },
      }),
    );
    expect(s.items[0]!.run.steps.classification.status).toBe('error');
    expect(stageCounts(s)).toMatchObject({ upload: 2, classification: 2, captioning: 0 });
  });
});
