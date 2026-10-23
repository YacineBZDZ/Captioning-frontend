import { pct } from '../format';
import type { ErrorCode, StepId } from './types';

/** An error as the UI sees it, whatever its origin (stream, HTTP body, client). */
export interface AppError {
  code: ErrorCode | (string & {});
  /** Message sent by the server, if any. Displayed as text only. */
  serverMessage?: string;
  step?: StepId;
  requestId?: string;
  details?: Record<string, unknown>;
  httpStatus?: number;
  retryAfterS?: number;
}

export type SuggestedAction =
  | 'choose_another' // pick a different file
  | 'retry' // send the same file again
  | 'retry_after' // retry, but only after a delay
  | 'wait_for_server' // retried automatically once the server is online
  | 'none';

export interface ErrorDescription {
  title: string;
  message: string;
  action: SuggestedAction;
  actionLabel: string;
}

export interface ErrorContext {
  maxUploadMb: number;
  allowedTypes: string[];
}

interface Entry {
  title: string;
  message: (err: AppError, ctx: ErrorContext) => string;
  action: SuggestedAction;
  actionLabel: string;
}

export function formatTypes(types: string[]): string {
  return types.map((t) => t.replace(/^image\//, '').toUpperCase()).join(', ');
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** "It looks like a painting, 93 % sure." */
export function notAPhotoSentence(details: Record<string, unknown> | undefined): string {
  const cls = typeof details?.predicted_class === 'string' ? details.predicted_class : null;
  const conf = typeof details?.confidence === 'number' ? details.confidence : null;
  if (!cls) return 'It does not look like a photograph.';
  const noun = cls.toLowerCase();
  // "Text" reads better without an article.
  const thing = noun === 'text' ? 'text' : `${article(noun)} ${noun}`;
  return conf === null ? `It looks like ${thing}.` : `It looks like ${thing}, ${pct(conf)} sure.`;
}

const ENTRIES: Record<ErrorCode, Entry> = {
  NOT_A_PHOTO: {
    title: "This doesn't look like a photograph",
    message: (err) => {
      const base = `${notAPhotoSentence(err.details)} The captioning model was trained on photographs only, so we stopped here.`;
      return err.details?.rechecked === true
        ? `${base} We also tried cleaning the image and checked again.`
        : base;
    },
    action: 'choose_another',
    actionLabel: 'Choose another image',
  },
  INVALID_IMAGE: {
    title: 'The image could not be read',
    message: () =>
      'The file may be damaged, too small (each side must be at least 32 px) or too large in pixels.',
    action: 'choose_another',
    actionLabel: 'Choose another image',
  },
  INVALID_PARAMETER: {
    title: 'An option was not accepted',
    message: () => 'The server rejected one of the options. Reset the options and try again.',
    action: 'retry',
    actionLabel: 'Try again',
  },
  FILE_TOO_LARGE: {
    title: 'The file is too large',
    message: (_e, ctx) => `The server accepts files up to ${ctx.maxUploadMb} MB.`,
    action: 'choose_another',
    actionLabel: 'Choose a smaller image',
  },
  UNSUPPORTED_TYPE: {
    title: 'This file type is not supported',
    message: (_e, ctx) => `Supported types: ${formatTypes(ctx.allowedTypes)}.`,
    action: 'choose_another',
    actionLabel: 'Choose another image',
  },
  SERVER_BUSY: {
    title: 'The server is busy',
    message: (err) =>
      err.retryAfterS
        ? `Too many images are being processed. You can retry in ${err.retryAfterS} s.`
        : 'Too many images are being processed. Please retry in a moment.',
    action: 'retry_after',
    actionLabel: 'Retry',
  },
  MODEL_NOT_READY: {
    title: 'The models are still loading',
    message: () =>
      'The server has just started. Your image will be sent again automatically when it is ready.',
    action: 'wait_for_server',
    actionLabel: 'Retry now',
  },
  INTERNAL_ERROR: {
    title: 'Something went wrong on the server',
    message: (err) =>
      err.requestId
        ? `Please retry. If it keeps happening, quote this request ID: ${err.requestId}.`
        : 'Please retry. If it keeps happening, try another image.',
    action: 'retry',
    actionLabel: 'Retry',
  },
  CONNECTION_LOST: {
    title: 'The connection was lost',
    message: () =>
      'The server stopped answering before the analysis finished. It may have restarted.',
    action: 'retry',
    actionLabel: 'Retry',
  },
  TIMEOUT: {
    title: 'The server took too long',
    message: () => 'No progress was received for 60 seconds, so the request was cancelled.',
    action: 'retry',
    actionLabel: 'Retry',
  },
  SERVER_OFFLINE: {
    title: 'The server could not be reached',
    message: () =>
      'It may be asleep or restarting. Free servers sleep after a period of inactivity; use "Wake up server" in the header.',
    action: 'retry',
    actionLabel: 'Retry',
  },
  HTTP_ERROR: {
    title: 'Unexpected server response',
    message: (err) =>
      err.httpStatus
        ? `The server answered with HTTP ${err.httpStatus}.`
        : 'The server answered with something we did not understand.',
    action: 'retry',
    actionLabel: 'Retry',
  },
};

export function describeError(err: AppError, ctx: ErrorContext): ErrorDescription {
  const entry = (ENTRIES as Record<string, Entry | undefined>)[err.code] ?? ENTRIES.INTERNAL_ERROR;
  return {
    title: entry.title,
    message: entry.message(err, ctx),
    action: entry.action,
    actionLabel: entry.actionLabel,
  };
}

/** Builds an AppError from a contract error body (HTTP body or in-stream event). */
export function fromErrorBody(
  body: { code: string; message?: string; step?: StepId; request_id?: string; details?: unknown },
  extra: { httpStatus?: number; requestId?: string | null; retryAfterHeader?: string | null } = {},
): AppError {
  const details =
    typeof body.details === 'object' && body.details !== null
      ? (body.details as Record<string, unknown>)
      : undefined;
  let retryAfterS: number | undefined;
  const fromDetails = details?.retry_after ?? details?.retry_after_s;
  if (typeof fromDetails === 'number') retryAfterS = fromDetails;
  const headerValue = extra.retryAfterHeader ? Number(extra.retryAfterHeader) : NaN;
  if (Number.isFinite(headerValue) && headerValue >= 0) retryAfterS = headerValue;
  return {
    code: body.code,
    serverMessage: body.message,
    step: body.step,
    requestId: body.request_id ?? extra.requestId ?? undefined,
    details,
    httpStatus: extra.httpStatus,
    retryAfterS,
  };
}
