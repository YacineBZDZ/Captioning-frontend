import { fromErrorBody, type AppError } from './errors';
import { readNdjson } from './ndjson';
import {
  isStreamEvent,
  type DecodingMode,
  type DenoiseMode,
  type HealthBody,
  type InfoBody,
  type StreamEvent,
} from './types';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  baseUrl: string;
  fetch: FetchFn;
}

export function createApiClient(baseUrl: string, fetchFn: FetchFn): ApiClient {
  return { baseUrl: baseUrl.replace(/\/+$/, ''), fetch: fetchFn };
}

// ---- /health ---------------------------------------------------------------

export type HealthResult =
  | { kind: 'ok'; body: HealthBody }
  | { kind: 'loading'; body: HealthBody }
  | { kind: 'fail'; reason: string };

export const HEALTH_TIMEOUT_MS = 5000;

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One health probe. Anything that is not exactly the contract (network error,
 * CORS, timeout, an HTML page from a sleeping Space...) counts as a failure.
 */
export async function checkHealth(
  api: ApiClient,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await api.fetch(`${api.baseUrl}/health`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    const body = (await readJson(res)) as Partial<HealthBody> | undefined;
    if (res.status === 200 && body?.status === 'ok') return { kind: 'ok', body: body as HealthBody };
    if (res.status === 503 && body?.status === 'loading')
      return { kind: 'loading', body: body as HealthBody };
    return { kind: 'fail', reason: `unexpected response (HTTP ${res.status})` };
  } catch (err) {
    return {
      kind: 'fail',
      reason: controller.signal.aborted ? 'timeout' : err instanceof Error ? err.message : 'error',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- /v1/info --------------------------------------------------------------

export interface ServerInfo {
  maxUploadMb: number;
  allowedTypes: string[];
  classes: string[];
  photoThreshold: number;
  calibrated: boolean | null;
  models: { classifier: string; denoiser: string; captioner: string };
  version: string | null;
}

export const DEFAULT_INFO: ServerInfo = {
  maxUploadMb: 10,
  allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'],
  classes: ['Painting', 'Photo', 'Schematics', 'Sketch', 'Text'],
  photoThreshold: 0.5,
  calibrated: null,
  models: { classifier: 'MobileNetV2', denoiser: 'unet_mixed', captioner: 'InceptionV3 + GRU' },
  version: null,
};

export function normaliseInfo(raw: unknown): ServerInfo {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_INFO;
  const r = raw as Partial<InfoBody>;
  const types =
    Array.isArray(r.allowed_types) && r.allowed_types.every((t) => typeof t === 'string')
      ? r.allowed_types
      : DEFAULT_INFO.allowedTypes;
  return {
    maxUploadMb:
      typeof r.max_upload_mb === 'number' && r.max_upload_mb > 0
        ? r.max_upload_mb
        : DEFAULT_INFO.maxUploadMb,
    allowedTypes: types.length ? types : DEFAULT_INFO.allowedTypes,
    classes: Array.isArray(r.classes) ? r.classes.map(String) : DEFAULT_INFO.classes,
    photoThreshold:
      typeof r.photo_threshold === 'number' ? r.photo_threshold : DEFAULT_INFO.photoThreshold,
    calibrated: typeof r.quality?.calibrated === 'boolean' ? r.quality.calibrated : null,
    models: { ...DEFAULT_INFO.models, ...(r.models ?? {}) },
    version: typeof r.version === 'string' ? r.version : null,
  };
}

export async function fetchInfo(api: ApiClient, signal?: AbortSignal): Promise<ServerInfo> {
  try {
    const res = await api.fetch(`${api.baseUrl}/v1/info`, { signal });
    if (!res.ok) return DEFAULT_INFO;
    return normaliseInfo(await readJson(res));
  } catch {
    return DEFAULT_INFO;
  }
}

// ---- /v1/process -----------------------------------------------------------

export interface ProcessOptions {
  denoise: DenoiseMode;
  decoding: DecodingMode;
}

export type ProcessOutcome =
  | { type: 'terminal' }
  | { type: 'cancelled' }
  | { type: 'failed'; error: AppError };

export const IDLE_TIMEOUT_MS = 60_000;

/**
 * Sends the image and feeds every stream event to `onEvent`. Never throws:
 * transport problems are returned as a client-side AppError.
 */
export async function processImage(params: {
  api: ApiClient;
  file: Blob;
  filename?: string;
  options: ProcessOptions;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
  idleTimeoutMs?: number;
}): Promise<ProcessOutcome> {
  const { api, file, options, signal, onEvent, idleTimeoutMs = IDLE_TIMEOUT_MS } = params;
  if (signal.aborted) return { type: 'cancelled' };

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  const onOuterAbort = () => controller.abort();
  signal.addEventListener('abort', onOuterAbort);

  const form = new FormData();
  form.append('file', file, params.filename ?? (file instanceof File ? file.name : 'image'));
  form.append('denoise', options.denoise);
  form.append('decoding', options.decoding);

  let response: Response | undefined;
  const interrupted = (): ProcessOutcome | null => {
    if (signal.aborted) return { type: 'cancelled' };
    if (timedOut) return { type: 'failed', error: { code: 'TIMEOUT' } };
    return null;
  };

  try {
    armIdle();
    try {
      response = await api.fetch(`${api.baseUrl}/v1/process`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
        headers: { Accept: 'application/x-ndjson' },
      });
    } catch {
      return interrupted() ?? { type: 'failed', error: { code: 'SERVER_OFFLINE' } };
    }

    const requestId = response.headers.get('X-Request-ID');

    if (!response.ok) {
      const body = await readJson(response).catch(() => undefined);
      const b = body as { code?: unknown } | undefined;
      if (b && typeof b.code === 'string') {
        return {
          type: 'failed',
          error: fromErrorBody(body as { code: string }, {
            httpStatus: response.status,
            requestId,
            retryAfterHeader: response.headers.get('Retry-After'),
          }),
        };
      }
      return {
        type: 'failed',
        error: { code: 'HTTP_ERROR', httpStatus: response.status, requestId: requestId ?? undefined },
      };
    }

    if (!response.body) {
      return { type: 'failed', error: { code: 'CONNECTION_LOST', requestId: requestId ?? undefined } };
    }

    try {
      for await (const item of readNdjson(response.body)) {
        armIdle();
        if (!item.ok || !isStreamEvent(item.value)) continue; // ignore junk lines
        onEvent(item.value);
        if (item.value.event === 'result' || item.value.event === 'error') {
          controller.abort(); // stop reading; the server closes the stream anyway
          return { type: 'terminal' };
        }
      }
    } catch {
      return (
        interrupted() ?? {
          type: 'failed',
          error: { code: 'CONNECTION_LOST', requestId: requestId ?? undefined },
        }
      );
    }
    return (
      interrupted() ?? {
        type: 'failed',
        error: { code: 'CONNECTION_LOST', requestId: requestId ?? undefined },
      }
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onOuterAbort);
  }
}
