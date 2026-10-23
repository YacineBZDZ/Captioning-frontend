// In-memory emulation of the backend (API contract v1) for development and
// tests. It is only ever loaded through a dynamic import when VITE_MOCK=true,
// or directly by tests, so it never ends up in the production bundle.

import type {
  ClassificationData,
  DenoisingData,
  ErrorBody,
  InfoBody,
  QualityData,
  StepId,
} from '../api/types';

export const SCENARIOS = [
  { id: 'clean_photo', label: 'Clean photo' },
  { id: 'noisy_photo', label: 'Noisy photo (denoising applied)' },
  { id: 'rescued_photo', label: 'Noisy photo misclassified, then rescued' },
  { id: 'clean_painting', label: 'Clean painting (NOT_A_PHOTO)' },
  { id: 'degraded_painting', label: 'Degraded painting (NOT_A_PHOTO, rechecked)' },
  { id: 'invalid_image', label: 'Invalid image' },
  { id: 'file_too_large', label: 'File too large (413)' },
  { id: 'server_busy', label: 'Server busy (429)' },
  { id: 'internal_error', label: 'Internal error' },
  { id: 'connection_lost', label: 'Connection lost mid-stream' },
  { id: 'server_starting', label: 'Server starting (models loading)' },
  { id: 'server_offline', label: 'Server offline / asleep' },
] as const;

export type ScenarioId = (typeof SCENARIOS)[number]['id'];

export interface MockBackendOptions {
  scenario?: ScenarioId;
  /** Returns a delay in ms between `min` and `max`. Tests pass `() => 0`. */
  delay?: (min: number, max: number) => number;
  /** How long "server_starting" answers 503 before turning healthy. */
  startupMs?: number;
}

export const MOCK_INFO: InfoBody = {
  version: '1.0.0-mock',
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
      return step('denoising', [100, 100], { applied: false, reason: 'disabled_by_request' }, 'skipped');
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
      timings_ms: { validation: 150, classification: 300, quality: 150, denoising: denoised ? 1200 : 0, captioning: 1050 },
      total_ms: denoised ? 2850 : 1650,
    },
  });
  const notAPhoto = (cls: ClassificationData, stepName: StepId, rechecked: boolean): ScriptItem => ({
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

    const form = init?.body instanceof FormData ? init.body : null;
    const fileEntry = form?.get('file');
    const file = fileEntry instanceof Blob ? fileEntry : null;
    const requestId = (++counter).toString(16).padStart(8, '0');
    const headers = { 'X-Request-ID': requestId };

    const err = (body: ErrorBody, status: number, extra: Record<string, string> = {}) =>
      json({ request_id: requestId, ...body }, status, { ...headers, ...extra });

    if (starting())
      return err({ code: 'MODEL_NOT_READY', message: 'Models are still loading.' }, 503);
    if (scenario === 'file_too_large')
      return err(
        { code: 'FILE_TOO_LARGE', message: 'File exceeds 10 MB.', details: { max_upload_mb: 10 } },
        413,
      );
    if (scenario === 'server_busy')
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
      denoise: (['auto', 'always', 'never'] as const).find((m) => m === form?.get('denoise')) ?? 'auto',
    };
    const script = buildScript(scenario, ctx);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const item of script) {
            await sleep(delay(item.wait[0], item.wait[1]), signal);
            if (item.close) {
              controller.close();
              return;
            }
            // Split each line across two chunks to exercise the client buffer.
            const text = JSON.stringify(item.line) + '\n';
            const cut = Math.floor(text.length / 2);
            controller.enqueue(encoder.encode(text.slice(0, cut)));
            controller.enqueue(encoder.encode(text.slice(cut)));
          }
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

  return {
    async fetch(input, init) {
      const path = new URL(input, 'http://mock.local').pathname;
      if (path.endsWith('/health')) return health(init?.signal);
      if (path.endsWith('/v1/info')) {
        await sleep(delay(40, 120), init?.signal);
        if (scenario === 'server_offline') throw new TypeError('Failed to fetch');
        return json(MOCK_INFO, 200);
      }
      if (path.endsWith('/v1/process') && init?.method === 'POST') return process(init);
      return json({ code: 'NOT_FOUND' }, 404);
    },
    getScenario: () => scenario,
    setScenario(id) {
      scenario = id;
      scenarioSince = Date.now();
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
