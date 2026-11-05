// In-memory emulation of the backend (API contract v1 and v1.1) for
// development and tests. It is only ever loaded through a dynamic import when
// VITE_MOCK=true, or directly by tests, so it never ends up in the production
// bundle.

import type {
  ClassificationData,
  DenoisingData,
  ErrorBody,
  InfoBody,
  QualityData,
  StepId,
} from '../api/types';

const range = (n: number, name: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => name(i + 1));
const pad = (i: number) => String(i).padStart(2, '0');

/** A varied set: mostly clean photos, some noisy, a few paintings. */
const variedSet = (n: number) =>
  range(n, (i) =>
    i % 9 === 0
      ? `painting-${pad(i)}.jpg`
      : i % 4 === 0
        ? `noisy-${pad(i)}.jpg`
        : `photo-${pad(i)}.jpg`,
  );

export const SCENARIOS = [
  { id: 'clean_photo', label: 'Clean photo', kind: 'single' },
  { id: 'noisy_photo', label: 'Noisy photo (denoising applied)', kind: 'single' },
  { id: 'rescued_photo', label: 'Noisy photo misclassified, then rescued', kind: 'single' },
  { id: 'clean_painting', label: 'Clean painting (NOT_A_PHOTO)', kind: 'single' },
  { id: 'degraded_painting', label: 'Degraded painting (NOT_A_PHOTO, rechecked)', kind: 'single' },
  { id: 'invalid_image', label: 'Invalid image', kind: 'single' },
  { id: 'file_too_large', label: 'File too large (413)', kind: 'single' },
  { id: 'server_busy', label: 'Server busy (429)', kind: 'single' },
  { id: 'internal_error', label: 'Internal error', kind: 'single' },
  { id: 'connection_lost', label: 'Connection lost mid-stream', kind: 'single' },
  { id: 'server_starting', label: 'Server starting (models loading)', kind: 'single' },
  { id: 'server_offline', label: 'Server offline / asleep', kind: 'single' },
  {
    id: 'batch_mixed',
    label: 'Mixed batch (one of each)',
    kind: 'batch',
    files: [
      'photo.jpg',
      'painting.jpg',
      'degraded-painting.jpg',
      'noisy-street.jpg',
      'rescue-beach.jpg',
      'bad-file.jpg',
    ],
  },
  {
    id: 'batch_clean_12',
    label: '12 clean photos',
    kind: 'batch',
    files: range(12, (i) => `photo-${pad(i)}.jpg`),
  },
  {
    id: 'batch_not_photos',
    label: 'All not photos',
    kind: 'batch',
    files: ['painting-1.jpg', 'painting-2.jpg', 'degraded-painting.jpg', 'paint-sketch.png'],
  },
  {
    id: 'batch_invalid',
    label: 'Only invalid files',
    kind: 'batch',
    files: ['bad-1.jpg', 'bad-2.png', 'notes.txt'],
  },
  { id: 'batch_20', label: '20 images', kind: 'batch', files: variedSet(20) },
  {
    id: 'batch_45',
    label: '45 images (auto-split, limit 20)',
    kind: 'batch',
    files: variedSet(45),
  },
  { id: 'batch_busy', label: 'Batch: server busy (429)', kind: 'batch', files: variedSet(6) },
  {
    id: 'batch_too_many',
    label: 'Batch: TOO_MANY_FILES (server really allows 5)',
    kind: 'batch',
    files: variedSet(8),
  },
  {
    id: 'batch_connection_lost',
    label: 'Batch: connection lost mid-batch',
    kind: 'batch',
    files: variedSet(8),
  },
  {
    id: 'batch_heartbeat_timeout',
    label: 'Batch: only heartbeats, then silence (90 s timeout)',
    kind: 'batch',
    files: variedSet(4),
  },
  {
    id: 'batch_item_timeout',
    label: 'Batch: one item hits BATCH_TIMEOUT',
    kind: 'batch',
    files: variedSet(6),
  },
  {
    id: 'old_backend',
    label: 'Old backend (no batch support)',
    kind: 'batch',
    files: variedSet(3),
  },
] as const;

export type ScenarioId = (typeof SCENARIOS)[number]['id'];

const isBatchScenario = (id: ScenarioId) => id.startsWith('batch_') || id === 'old_backend';

export interface MockBackendOptions {
  scenario?: ScenarioId;
  /** Returns a delay in ms between `min` and `max`. Tests pass `() => 0`. */
  delay?: (min: number, max: number) => number;
  /** How long "server_starting" answers 503 before turning healthy. */
  startupMs?: number;
}

export const MOCK_BATCH_LIMITS = {
  max_images: 20,
  max_total_mb: 60,
  micro_batch_size: 8,
  max_seconds: 600,
};

export const MOCK_INFO: InfoBody = {
  version: '1.1.0-mock',
  batch: MOCK_BATCH_LIMITS,
  max_upload_mb: 10,
  allowed_types: ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'],
  classes: ['Painting', 'Photo', 'Schematics', 'Sketch', 'Text'],
  photo_threshold: 0.5,
  quality: { calibrated: false, noise_sigma_threshold: 0.02, sharpness_threshold: 60.0 },
  models: { classifier: 'MobileNetV2', denoiser: 'unet_mixed', captioner: 'InceptionV3 + GRU' },
  defaults: { denoise: 'auto', decoding: 'beam' },
};

const CLASSES = MOCK_INFO.classes;

function classification(
  predicted: string,
  confidence: number,
  input: 'original' | 'denoised' = 'original',
): ClassificationData {
  const others = CLASSES.filter((c) => c !== predicted);
  const rest = 1 - confidence;
  const weights = [0.5, 0.25, 0.15, 0.1];
  const probabilities: Record<string, number> = {};
  others.forEach((c, i) => (probabilities[c] = Number((rest * (weights[i] ?? 0)).toFixed(3))));
  probabilities[predicted] = confidence;
  return {
    predicted_class: predicted,
    confidence,
    probabilities,
    is_photo: predicted === 'Photo' && confidence >= 0.5,
    photo_threshold: 0.5,
    input,
  };
}

function quality(reason: QualityData['reason']): QualityData {
  const noisy = reason === 'noisy' || reason === 'noisy_and_blurry';
  const blurry = reason === 'blurry' || reason === 'noisy_and_blurry';
  return {
    noise_sigma: noisy ? 0.047 : 0.008,
    sharpness: blurry ? 31.4 : 148.2,
    is_noisy: noisy,
    is_blurry: blurry,
    reason,
    needs_denoising: noisy || blurry,
    thresholds: { noise_sigma: 0.02, sharpness: 60.0 },
    calibrated: false,
  };
}

const FALLBACK_DENOISED =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7aa6a1"/><stop offset="1" stop-color="#2f4f4c"/></linearGradient></defs><rect width="192" height="192" fill="url(#g)"/></svg>',
  );

/** Shrinks the uploaded image to 192x192 like the real U-Net output, when a canvas exists. */
async function fakeDenoised(file: Blob | null): Promise<string> {
  try {
    if (!file || typeof createImageBitmap !== 'function') return FALLBACK_DENOISED;
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');
    if (!ctx) return FALLBACK_DENOISED;
    ctx.filter = 'blur(0.6px) saturate(0.9)';
    ctx.drawImage(bitmap, 0, 0, 192, 192);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return FALLBACK_DENOISED;
  }
}

async function imageSize(file: Blob | null): Promise<{ width: number; height: number }> {
  try {
    if (file && typeof createImageBitmap === 'function') {
      const b = await createImageBitmap(file);
      return { width: b.width, height: b.height };
    }
  } catch {
    // fall through
  }
  return { width: 1024, height: 768 };
}

function formatOf(type: string): string {
  const t = type.replace('image/', '').toUpperCase();
  return t === 'JPG' ? 'JPEG' : t || 'JPEG';
}

type Line = Record<string, unknown>;
interface ScriptItem {
  /** Delay before emitting, [min, max] ms. */
  wait: [number, number];
  line?: Line;
  /** Close the stream abruptly at this point. */
  close?: true;
}

interface RunContext {
  requestId: string;
  filename: string;
  bytes: number;
  type: string;
  width: number;
  height: number;
  denoised: string;
  decoding: 'beam' | 'greedy';
  denoise: 'auto' | 'always' | 'never';
}

function step(name: StepId, wait: [number, number], data: unknown, status = 'done'): ScriptItem[] {
  const elapsed = Math.round((wait[0] + wait[1]) / 2);
  return [
    { wait: [40, 120], line: { event: 'step', step: name, status: 'running' } },
    { wait, line: { event: 'step', step: name, status, elapsed_ms: elapsed, data } },
  ];
}

function buildScript(scenario: ScenarioId, c: RunContext): ScriptItem[] {
  const started: ScriptItem = {
    wait: [100, 250],
    line: {
      event: 'started',
      request_id: c.requestId,
      filename: c.filename,
      width: c.width,
      height: c.height,
      bytes: c.bytes,
    },
  };
  const validation = step('validation', [100, 200], {
    width: c.width,
    height: c.height,
    format: formatOf(c.type),
    bytes: c.bytes,
  });
  const denoisedData = (): DenoisingData => ({
    applied: true,
    model: 'unet_mixed',
    image: c.denoised,
    width: 192,
    height: 192,
  });
  const denoising = (needed: boolean): ScriptItem[] => {
    if (c.denoise === 'never')
      return step(
        'denoising',
        [100, 100],
        { applied: false, reason: 'disabled_by_request' },
        'skipped',
      );
    if (needed || c.denoise === 'always') return step('denoising', [900, 1500], denoisedData());
    return step('denoising', [100, 100], { applied: false, reason: 'clean' }, 'skipped');
  };
  const applied = (needed: boolean) => c.denoise === 'always' || (needed && c.denoise !== 'never');
  const caption = (text: string, input: 'original' | 'denoised'): ScriptItem[] =>
    step('captioning', [700, 1400], {
      caption: text,
      decoding: c.decoding,
      beam_width: c.decoding === 'beam' ? 3 : 1,
      input,
    });
  const result = (
    text: string,
    cls: ClassificationData,
    q: QualityData,
    denoised: boolean,
  ): ScriptItem => ({
    wait: [50, 100],
    line: {
      event: 'result',
      caption: text,
      classification: cls,
      quality: q,
      denoising: { applied: denoised },
      timings_ms: {
        validation: 150,
        classification: 300,
        quality: 150,
        ...(denoised ? { denoising: 1200 } : {}),
        captioning: 1050,
      },
      total_ms: denoised ? 2850 : 1650,
    },
  });
  const notAPhoto = (
    cls: ClassificationData,
    stepName: StepId,
    rechecked: boolean,
  ): ScriptItem => ({
    wait: [50, 100],
    line: {
      event: 'error',
      code: 'NOT_A_PHOTO',
      step: stepName,
      request_id: c.requestId,
      message: `This image looks like a ${cls.predicted_class.toLowerCase()} (${Math.round(cls.confidence * 100)} %), not a photograph.`,
      details: { ...cls, rechecked },
    },
  });

  switch (scenario) {
    case 'clean_photo':
    case 'server_starting': {
      const cls = classification('Photo', 0.97);
      const q = quality('clean');
      const d = applied(false);
      const text = 'a brown bear is standing in the grass';
      return [
        started,
        ...validation,
        ...step('classification', [250, 400], cls),
        ...step('quality', [100, 200], q),
        ...denoising(false),
        ...caption(text, d ? 'denoised' : 'original'),
        result(text, cls, q, d),
      ];
    }
    case 'noisy_photo': {
      const cls = classification('Photo', 0.91);
      const q = quality('noisy');
      const d = applied(true);
      const text = 'a man riding a bike down a city street';
      return [
        started,
        ...validation,
        ...step('classification', [250, 400], cls),
        ...step('quality', [100, 200], q),
        ...denoising(true),
        ...caption(text, d ? 'denoised' : 'original'),
        result(text, cls, q, d),
      ];
    }
    case 'rescued_photo': {
      const first = classification('Painting', 0.62);
      const q = quality('noisy_and_blurry');
      const second = classification('Photo', 0.88, 'denoised');
      const text = 'a dog is running on the beach';
      return [
        started,
        ...validation,
        ...step('classification', [250, 400], first),
        ...step('quality', [100, 200], q),
        ...step('denoising', [900, 1500], denoisedData()),
        ...step('reclassification', [250, 400], second),
        ...caption(text, 'denoised'),
        result(text, second, q, true),
      ];
    }
    case 'clean_painting': {
      const cls = classification('Painting', 0.93);
      return [
        started,
        ...validation,
        ...step('classification', [250, 400], cls),
        ...step('quality', [100, 200], quality('clean')),
        notAPhoto(cls, 'classification', false),
      ];
    }
    case 'degraded_painting': {
      const first = classification('Painting', 0.71);
      const second = classification('Painting', 0.9, 'denoised');
      return [
        started,
        ...validation,
        ...step('classification', [250, 400], first),
        ...step('quality', [100, 200], quality('noisy')),
        ...step('denoising', [900, 1500], denoisedData()),
        ...step('reclassification', [250, 400], second),
        notAPhoto(second, 'reclassification', true),
      ];
    }
    case 'invalid_image':
      return [
        { wait: [100, 200], line: { event: 'step', step: 'validation', status: 'running' } },
        {
          wait: [100, 300],
          line: {
            event: 'error',
            code: 'INVALID_IMAGE',
            step: 'validation',
            request_id: c.requestId,
            message: 'The file could not be decoded as an image.',
          },
        },
      ];
    case 'internal_error':
      return [
        started,
        ...validation,
        ...step('classification', [250, 400], classification('Photo', 0.95)),
        ...step('quality', [100, 200], quality('clean')),
        ...denoising(false),
        { wait: [40, 120], line: { event: 'step', step: 'captioning', status: 'running' } },
        {
          wait: [400, 800],
          line: {
            event: 'error',
            code: 'INTERNAL_ERROR',
            step: 'captioning',
            request_id: c.requestId,
            message: 'Internal server error.',
          },
        },
      ];
    case 'connection_lost':
      return [
        started,
        ...validation,
        ...step('classification', [250, 400], classification('Photo', 0.95)),
        { wait: [40, 120], line: { event: 'step', step: 'quality', status: 'running' } },
        { wait: [400, 800], close: true },
      ];
    default:
      return [];
  }
}

// ---- batch item behaviour, decided by the file name ---------------------------

export type MockItemKind = 'invalid' | 'degraded' | 'painting' | 'rescue' | 'noisy' | 'clean';

/** "bad" -> invalid file, "degraded" -> rejected after re-check, "paint" -> rejected
 * painting, "rescue" -> misclassified then rescued, "noisy" -> denoised, else clean. */
export function mockKindOf(filename: string): MockItemKind {
  const n = filename.toLowerCase();
  if (n.includes('bad')) return 'invalid';
  if (n.includes('degraded')) return 'degraded';
  if (n.includes('paint')) return 'painting';
  if (n.includes('rescue')) return 'rescue';
  if (n.includes('noisy')) return 'noisy';
  return 'clean';
}

const CAPTIONS = [
  'a brown bear is standing in the grass',
  'a man riding a bike down a city street',
  'a dog is running on the beach',
  'two cats sleeping on a couch',
  'a red bus parked on the side of a road',
  'a plate of food with broccoli and rice',
  'a group of people standing on a snowy hill',
  'a boat floating on a calm lake',
];

/** Deterministic caption for a file name, so tests can predict it. */
export function mockCaptionFor(filename: string): string {
  let h = 0;
  for (const ch of filename) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAPTIONS[h % CAPTIONS.length]!;
}

const BATCH_STAGES = [
  'classification',
  'quality',
  'denoising',
  'reclassification',
  'captioning',
] as const;
type BatchStage = (typeof BATCH_STAGES)[number];

const STAGE_DELAYS: Record<BatchStage, [number, number]> = {
  classification: [150, 400],
  quality: [80, 200],
  denoising: [600, 1300],
  reclassification: [150, 350],
  captioning: [500, 1200],
};

interface ItemPlan {
  index: number;
  filename: string;
  kind: MockItemKind;
  started: Record<string, unknown>;
  steps: Partial<Record<BatchStage, { status: 'done' | 'skipped'; data: unknown }>>;
  rejectAfter?: BatchStage;
  rejection?: Record<string, unknown>;
  ok?: Record<string, unknown>;
}

async function planItem(
  file: File,
  index: number,
  denoise: 'auto' | 'always' | 'never',
  decoding: 'beam' | 'greedy',
): Promise<ItemPlan> {
  const kind = mockKindOf(file.name);
  const base = { index, filename: file.name, bytes: file.size };
  if (kind === 'invalid' || !file.type.startsWith('image/')) {
    const rejection = {
      code: kind === 'invalid' ? 'INVALID_IMAGE' : 'UNSUPPORTED_TYPE',
      message:
        kind === 'invalid'
          ? 'The file could not be decoded as an image.'
          : 'Unsupported file type.',
    };
    return {
      index,
      filename: file.name,
      kind: 'invalid',
      started: { ...base, status: 'rejected', error: rejection },
      steps: {},
      rejection,
    };
  }
  const size = await imageSize(file);
  const started = { ...base, ...size, format: formatOf(file.type), status: 'accepted' };
  const first = {
    clean: classification('Photo', 0.97),
    noisy: classification('Photo', 0.91),
    painting: classification('Painting', 0.93),
    degraded: classification('Painting', 0.71),
    rescue: classification('Painting', 0.62),
  }[kind];
  const q = quality(
    (
      {
        clean: 'clean',
        noisy: 'noisy',
        painting: 'clean',
        degraded: 'noisy',
        rescue: 'noisy_and_blurry',
      } as const
    )[kind],
  );
  const apply = denoise === 'always' || (denoise === 'auto' && q.needs_denoising);
  const plan: ItemPlan = {
    index,
    filename: file.name,
    kind,
    started,
    steps: {
      classification: { status: 'done', data: first },
      quality: { status: 'done', data: q },
    },
  };
  const notAPhoto = (cls: ClassificationData, step: StepId, rechecked: boolean) => ({
    code: 'NOT_A_PHOTO',
    step,
    message: `This image looks like a ${cls.predicted_class.toLowerCase()} (${Math.round(cls.confidence * 100)} %), not a photograph.`,
    details: { ...cls, rechecked },
  });

  if (!first.is_photo && !apply) {
    plan.rejectAfter = 'quality';
    plan.rejection = notAPhoto(first, 'classification', false);
    return plan;
  }
  plan.steps.denoising = apply
    ? {
        status: 'done',
        data: {
          applied: true,
          model: 'unet_mixed',
          image: await fakeDenoised(file),
          width: 192,
          height: 192,
        },
      }
    : {
        status: 'skipped',
        data: { applied: false, reason: denoise === 'never' ? 'disabled_by_request' : 'clean' },
      };

  let final = first;
  if (!first.is_photo) {
    final =
      kind === 'rescue'
        ? classification('Photo', 0.88, 'denoised')
        : classification('Painting', 0.9, 'denoised');
    plan.steps.reclassification = { status: 'done', data: final };
    if (!final.is_photo) {
      plan.rejectAfter = 'reclassification';
      plan.rejection = notAPhoto(final, 'reclassification', true);
      return plan;
    }
  }
  const caption = mockCaptionFor(file.name);
  plan.steps.captioning = {
    status: 'done',
    data: {
      caption,
      decoding,
      beam_width: decoding === 'beam' ? 3 : 1,
      input: apply ? 'denoised' : 'original',
    },
  };
  plan.ok = {
    status: 'ok',
    caption,
    classification: final,
    quality: q,
    denoising: { applied: apply },
  };
  return plan;
}

const encoder = new TextEncoder();

/** A streamed NDJSON response; each line is split across two chunks on purpose. */
function ndjsonResponse(
  produce: (emit: (line: Record<string, unknown>) => void) => Promise<void>,
  headers: Record<string, string>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (line: Record<string, unknown>) => {
        const text = JSON.stringify(line) + '\n';
        const cut = Math.floor(text.length / 2);
        controller.enqueue(encoder.encode(text.slice(0, cut)));
        controller.enqueue(encoder.encode(text.slice(cut)));
      };
      try {
        await produce(emit);
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson', ...headers },
  });
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const randomDelay = (min: number, max: number) => min + Math.random() * (max - min);

export interface MockBackend {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  getScenario: () => ScenarioId;
  setScenario: (id: ScenarioId) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createMockBackend(options: MockBackendOptions = {}): MockBackend {
  let scenario: ScenarioId = options.scenario ?? 'clean_photo';
  let scenarioSince = Date.now();
  const delay = options.delay ?? randomDelay;
  const startupMs = options.startupMs ?? 8000;
  const listeners = new Set<() => void>();
  let counter = 0;

  const starting = () => scenario === 'server_starting' && Date.now() - scenarioSince < startupMs;

  async function health(signal?: AbortSignal | null): Promise<Response> {
    await sleep(delay(40, 120), signal);
    if (scenario === 'server_offline') {
      // A sleeping Hugging Face Space answers with an HTML page.
      return new Response('<!doctype html><html><body>Space is sleeping</body></html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    const loading = starting();
    return json(
      {
        status: loading ? 'loading' : 'ok',
        models: { classifier: true, denoiser: !loading, captioner: !loading },
        uptime_s: Math.round((Date.now() - scenarioSince) / 1000),
        version: MOCK_INFO.version,
      },
      loading ? 503 : 200,
    );
  }

  async function process(init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    await sleep(delay(150, 400), signal);
    if (scenario === 'server_offline') throw new TypeError('Failed to fetch');
    // Batch scenarios describe /v1/batch; a single image is then a clean photo.
    const scenarioFor1 = isBatchScenario(scenario) ? 'clean_photo' : scenario;

    const form = init?.body instanceof FormData ? init.body : null;
    const fileEntry = form?.get('file');
    const file = fileEntry instanceof Blob ? fileEntry : null;
    const requestId = (++counter).toString(16).padStart(8, '0');
    const headers = { 'X-Request-ID': requestId };

    const err = (body: ErrorBody, status: number, extra: Record<string, string> = {}) =>
      json({ request_id: requestId, ...body }, status, { ...headers, ...extra });

    if (starting())
      return err({ code: 'MODEL_NOT_READY', message: 'Models are still loading.' }, 503);
    if (scenarioFor1 === 'file_too_large')
      return err(
        { code: 'FILE_TOO_LARGE', message: 'File exceeds 10 MB.', details: { max_upload_mb: 10 } },
        413,
      );
    if (scenarioFor1 === 'server_busy')
      return err(
        { code: 'SERVER_BUSY', message: 'Too many requests.', details: { retry_after: 15 } },
        429,
        { 'Retry-After': '15' },
      );

    const size = await imageSize(file);
    const ctx: RunContext = {
      requestId,
      filename: file instanceof File ? file.name : 'image.jpg',
      bytes: file?.size ?? 183422,
      type: file?.type ?? 'image/jpeg',
      ...size,
      denoised: await fakeDenoised(file),
      decoding: form?.get('decoding') === 'greedy' ? 'greedy' : 'beam',
      denoise:
        (['auto', 'always', 'never'] as const).find((m) => m === form?.get('denoise')) ?? 'auto',
    };
    const script = buildScript(scenarioFor1, ctx);
    return ndjsonResponse(async (emit) => {
      for (const item of script) {
        await sleep(delay(item.wait[0], item.wait[1]), signal);
        if (item.close) return;
        emit(item.line!);
      }
    }, headers);
  }

  // ---- POST /v1/batch (v1.1) -----------------------------------------------

  let batchRequests = 0;
  let tooManyAnswered = false;
  const realMaxImages = () => (scenario === 'batch_too_many' ? 5 : MOCK_BATCH_LIMITS.max_images);

  async function batch(init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    await sleep(delay(150, 400), signal);
    if (scenario === 'server_offline') throw new TypeError('Failed to fetch');
    const requestId = (++counter).toString(16).padStart(8, '0');
    const headers = { 'X-Request-ID': requestId };
    const err = (body: ErrorBody, status: number, extra: Record<string, string> = {}) =>
      json({ request_id: requestId, ...body }, status, { ...headers, ...extra });

    if (scenario === 'old_backend') return json({ detail: 'Not Found' }, 404, headers);
    if (starting())
      return err({ code: 'MODEL_NOT_READY', message: 'Models are still loading.' }, 503);
    if (scenario === 'batch_busy')
      return err(
        { code: 'SERVER_BUSY', message: 'Too many requests.', details: { retry_after: 10 } },
        429,
        { 'Retry-After': '10' },
      );

    const form = init?.body instanceof FormData ? init.body : null;
    const files = (form?.getAll('files') ?? []).filter((f): f is File => f instanceof File);
    if (files.length === 0)
      return err({ code: 'INVALID_PARAMETER', message: 'No files were sent.' }, 400);
    if (files.length > realMaxImages()) {
      if (scenario === 'batch_too_many') tooManyAnswered = true;
      return err(
        {
          code: 'TOO_MANY_FILES',
          message: `At most ${realMaxImages()} images per request.`,
          details: { max_images: realMaxImages(), received: files.length },
        },
        413,
      );
    }
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MOCK_BATCH_LIMITS.max_total_mb * 1024 * 1024)
      return err(
        {
          code: 'BATCH_TOO_LARGE',
          message: 'The images are too large together.',
          details: { max_total_mb: MOCK_BATCH_LIMITS.max_total_mb },
        },
        413,
      );

    const denoise =
      (['auto', 'always', 'never'] as const).find((m) => m === form?.get('denoise')) ?? 'auto';
    const decoding = form?.get('decoding') === 'greedy' ? 'greedy' : 'beam';
    const requestNumber = ++batchRequests;
    const plans = await Promise.all(
      files.map((file, index) => planItem(file, index, denoise, decoding)),
    );
    const flavour = scenario;

    return ndjsonResponse(async (emit) => {
      const wait = (min: number, max: number) => sleep(delay(min, max), signal);
      await wait(100, 250);
      emit({
        event: 'batch_started',
        request_id: requestId,
        count: files.length,
        items: plans.map((p) => p.started),
      });
      for (const p of plans)
        if (p.kind === 'invalid')
          emit({ event: 'item_done', index: p.index, status: 'error', error: p.rejection });
      emit({ event: 'mock_debug', note: 'unknown events must be ignored' });

      if (flavour === 'batch_heartbeat_timeout') {
        for (let t = 1; t <= 5; t++) {
          await wait(1500, 2500);
          emit({ event: 'heartbeat', t: t * 2 });
        }
        await new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(abortError()), { once: true }),
        );
        return;
      }

      const results = new Map<number, Record<string, unknown>>();
      for (const p of plans)
        if (p.kind === 'invalid')
          results.set(p.index, {
            index: p.index,
            filename: p.filename,
            status: 'error',
            error: p.rejection,
          });
      let alive = plans.filter((p) => p.kind !== 'invalid');
      const timings: Record<string, number> = {};
      const timeoutVictim =
        flavour === 'batch_item_timeout' && requestNumber === 1
          ? alive[alive.length - 1]?.index
          : undefined;

      const finish = (p: ItemPlan, line: Record<string, unknown>) => {
        emit({ event: 'item_done', ...line });
        const { image: _omit, ...rest } = line as { image?: unknown };
        void _omit;
        results.set(p.index, { filename: p.filename, ...rest });
        alive = alive.filter((a) => a !== p);
      };

      for (const stage of BATCH_STAGES) {
        const participants = alive.filter((p) => p.steps[stage] !== undefined);
        if (participants.length === 0) continue;
        emit({ event: 'stage', stage, status: 'running', count: participants.length });
        const started = Date.now();
        const [min, max] = STAGE_DELAYS[stage];
        for (let i = 0; i < participants.length; i += 3) {
          await wait(min, max);
          for (const p of participants.slice(i, i + 3)) {
            if (stage === 'captioning' && p.index === timeoutVictim) {
              finish(p, {
                index: p.index,
                status: 'error',
                error: {
                  code: 'BATCH_TIMEOUT',
                  step: 'captioning',
                  message: 'The batch ran out of time before this image was captioned.',
                },
              });
              continue;
            }
            const step = p.steps[stage]!;
            emit({
              event: 'item_step',
              index: p.index,
              step: stage,
              status: step.status,
              data: step.data,
            });
            if (p.rejectAfter === stage)
              finish(p, { index: p.index, status: 'error', error: p.rejection });
            if (stage === 'captioning') finish(p, { index: p.index, ...p.ok });
          }
          if (flavour === 'batch_connection_lost' && stage === 'captioning') return; // abrupt close
        }
        timings[stage] = Math.max(1, Date.now() - started) + Math.round((min + max) / 2);
        emit({
          event: 'stage',
          stage,
          status: 'done',
          count: participants.length,
          elapsed_ms: timings[stage],
        });
        emit({ event: 'heartbeat', t: Math.round((Date.now() - started) / 1000) });
      }

      const items = [...results.values()].sort((a, b) => (a.index as number) - (b.index as number));
      emit({
        event: 'batch_result',
        request_id: requestId,
        count: files.length,
        succeeded: items.filter((i) => i.status === 'ok').length,
        failed: items.filter((i) => i.status === 'error').length,
        timings_ms: timings,
        total_ms: Object.values(timings).reduce((a, b) => a + b, 0),
        items,
      });
    }, headers);
  }

  return {
    async fetch(input, init) {
      const path = new URL(input, 'http://mock.local').pathname;
      if (path.endsWith('/health')) return health(init?.signal);
      if (path.endsWith('/v1/info')) {
        await sleep(delay(40, 120), init?.signal);
        if (scenario === 'server_offline') throw new TypeError('Failed to fetch');
        if (scenario === 'old_backend') {
          const { batch: _batch, ...old } = MOCK_INFO;
          void _batch;
          return json({ ...old, version: '1.0.0-mock' }, 200);
        }
        if (scenario === 'batch_too_many' && tooManyAnswered)
          return json({ ...MOCK_INFO, batch: { ...MOCK_BATCH_LIMITS, max_images: 5 } }, 200);
        return json(MOCK_INFO, 200);
      }
      if (path.endsWith('/v1/process') && init?.method === 'POST') return process(init);
      if (path.endsWith('/v1/batch') && init?.method === 'POST') return batch(init);
      return json({ code: 'NOT_FOUND' }, 404);
    },
    getScenario: () => scenario,
    setScenario(id) {
      scenario = id;
      scenarioSince = Date.now();
      batchRequests = 0;
      tooManyAnswered = false;
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
