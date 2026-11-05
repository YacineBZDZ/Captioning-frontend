// POST /v1/batch (API contract v1.1): one request per group of images, read
// as an NDJSON stream with the same parser as the single-image flow.

import { readJson, type ApiClient, type ProcessOptions } from './client';
import { fromErrorBody, type AppError } from './errors';
import { readNdjson } from './ndjson';
import { isBatchStreamEvent, type BatchStreamEvent } from './types';

/** No line at all (heartbeats included) for this long means the server is gone. */
export const WATCHDOG_MS = 90_000;

export type GroupOutcome =
  { type: 'completed' } | { type: 'cancelled' } | { type: 'failed'; error: AppError };

export function batchFormData(files: readonly File[], options: ProcessOptions): FormData {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  form.append('denoise', options.denoise);
  form.append('decoding', options.decoding);
  return form;
}

/**
 * Sends one group and forwards each stream event to `onEvent`. A terminal
 * `error` event is not forwarded: it is returned as the failed outcome.
 * Never throws.
 */
export async function processBatch(params: {
  api: ApiClient;
  files: readonly File[];
  options: ProcessOptions;
  signal: AbortSignal;
  onEvent: (event: BatchStreamEvent) => void;
  watchdogMs?: number;
}): Promise<GroupOutcome> {
  const { api, files, options, signal, onEvent, watchdogMs = WATCHDOG_MS } = params;
  if (signal.aborted) return { type: 'cancelled' };

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, watchdogMs);
  };
  const onOuterAbort = () => controller.abort();
  signal.addEventListener('abort', onOuterAbort);

  let requestId: string | undefined;
  const interrupted = (fallback: AppError): GroupOutcome => {
    if (signal.aborted) return { type: 'cancelled' };
    if (timedOut)
      return {
        type: 'failed',
        error: {
          code: 'TIMEOUT',
          requestId,
          details: { timeout_s: Math.round(watchdogMs / 1000) },
        },
      };
    return { type: 'failed', error: fallback };
  };

  try {
    arm();
    let response: Response;
    try {
      response = await api.fetch(`${api.baseUrl}/v1/batch?stream=true`, {
        method: 'POST',
        body: batchFormData(files, options),
        signal: controller.signal,
        headers: { Accept: 'application/x-ndjson' },
      });
    } catch {
      return interrupted({ code: 'SERVER_OFFLINE' });
    }
    requestId = response.headers.get('X-Request-ID') ?? undefined;

    if (!response.ok) {
      const body = (await readJson(response).catch(() => undefined)) as
        { code?: unknown } | undefined;
      if (body && typeof body.code === 'string') {
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
        error: { code: 'HTTP_ERROR', httpStatus: response.status, requestId },
      };
    }
    if (!response.body) return { type: 'failed', error: { code: 'CONNECTION_LOST', requestId } };

    try {
      for await (const item of readNdjson(response.body)) {
        arm(); // any line, even one we ignore, proves the server is alive
        if (!item.ok || !isBatchStreamEvent(item.value)) continue;
        const event = item.value;
        if (event.event === 'error') {
          controller.abort();
          return {
            type: 'failed',
            error: { ...fromErrorBody(event), requestId: event.request_id ?? requestId },
          };
        }
        onEvent(event);
        if (event.event === 'batch_result') {
          controller.abort(); // the server closes the stream anyway
          return { type: 'completed' };
        }
      }
    } catch {
      return interrupted({ code: 'CONNECTION_LOST', requestId });
    }
    return interrupted({ code: 'CONNECTION_LOST', requestId });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onOuterAbort);
  }
}

export interface GroupPlan {
  /** Global indices of the files, in sending order. */
  indices: number[];
  files: File[];
}

export type RunEnd = 'completed' | 'cancelled' | 'stopped';

/**
 * Sends the groups one after another. Stops at the first batch-level failure
 * (the caller keeps every finished result) or when `signal` is aborted.
 */
export async function runGroups(params: {
  api: ApiClient;
  groups: readonly GroupPlan[];
  options: ProcessOptions;
  signal: AbortSignal;
  watchdogMs?: number;
  onGroupStart: (group: number) => void;
  onEvent: (group: number, event: BatchStreamEvent) => void;
  onGroupEnd: (group: number, outcome: GroupOutcome) => void;
}): Promise<RunEnd> {
  const { groups, signal } = params;
  for (let g = 0; g < groups.length; g++) {
    if (signal.aborted) return 'cancelled';
    params.onGroupStart(g);
    const outcome = await processBatch({
      api: params.api,
      files: groups[g]!.files,
      options: params.options,
      signal,
      watchdogMs: params.watchdogMs,
      onEvent: (event) => params.onEvent(g, event),
    });
    params.onGroupEnd(g, outcome);
    if (outcome.type === 'cancelled') return 'cancelled';
    if (outcome.type === 'failed') return 'stopped';
  }
  return 'completed';
}
