// Types for API contract v1. Keep in sync with the README "API contract" section.

export const CLASSES = ['Painting', 'Photo', 'Schematics', 'Sketch', 'Text'] as const;
export type ClassName = (typeof CLASSES)[number];

export const STEP_IDS = [
  'validation',
  'classification',
  'quality',
  'denoising',
  'reclassification',
  'captioning',
] as const;
export type StepId = (typeof STEP_IDS)[number];

export type DenoiseMode = 'auto' | 'always' | 'never';
export type DecodingMode = 'beam' | 'greedy';
export type ImageInput = 'original' | 'denoised';

// ---- GET /health ---------------------------------------------------------

export interface HealthBody {
  status: 'ok' | 'loading';
  models?: Record<string, boolean>;
  uptime_s?: number;
  version?: string;
}

// ---- GET /v1/info --------------------------------------------------------

export interface InfoBody {
  version: string;
  max_upload_mb: number;
  allowed_types: string[];
  classes: string[];
  photo_threshold: number;
  quality: {
    calibrated: boolean;
    noise_sigma_threshold: number;
    sharpness_threshold: number;
  };
  models: { classifier: string; denoiser: string; captioner: string };
  defaults: { denoise: DenoiseMode; decoding: DecodingMode };
  /** v1.1: present only on servers that support POST /v1/batch. */
  batch?: BatchInfoBody;
}

export interface BatchInfoBody {
  max_images: number;
  max_total_mb: number;
  micro_batch_size?: number;
  max_seconds?: number;
}

// ---- Step data -----------------------------------------------------------

export interface ValidationData {
  width: number;
  height: number;
  format: string;
  bytes: number;
}

export interface ClassificationData {
  predicted_class: string;
  confidence: number;
  probabilities: Record<string, number>;
  is_photo: boolean;
  photo_threshold: number;
  input: ImageInput;
}

export type QualityReason = 'clean' | 'noisy' | 'blurry' | 'noisy_and_blurry';

export interface QualityData {
  noise_sigma: number;
  sharpness: number;
  is_noisy: boolean;
  is_blurry: boolean;
  reason: QualityReason;
  needs_denoising: boolean;
  thresholds: { noise_sigma: number; sharpness: number };
  calibrated: boolean;
}

export interface DenoisingDoneData {
  applied: true;
  model: string;
  image: string;
  width: number;
  height: number;
}

export interface DenoisingSkippedData {
  applied: false;
  reason: 'clean' | 'disabled_by_request' | string;
}

export type DenoisingData = DenoisingDoneData | DenoisingSkippedData;

export interface CaptioningData {
  caption: string;
  decoding: DecodingMode;
  beam_width?: number;
  input: ImageInput;
}

export interface StepDataMap {
  validation: ValidationData;
  classification: ClassificationData;
  quality: QualityData;
  denoising: DenoisingData;
  reclassification: ClassificationData;
  captioning: CaptioningData;
}

// ---- Stream events -------------------------------------------------------

export interface StartedEvent {
  event: 'started';
  request_id: string;
  filename: string;
  width: number;
  height: number;
  bytes: number;
}

export interface StepRunningEvent {
  event: 'step';
  step: StepId;
  status: 'running';
}

export type StepFinishedEvent = {
  [K in StepId]: {
    event: 'step';
    step: K;
    status: 'done' | 'skipped';
    elapsed_ms?: number;
    data?: StepDataMap[K];
  };
}[StepId];

export type StepEvent = StepRunningEvent | StepFinishedEvent;

export interface ResultEvent {
  event: 'result';
  caption: string;
  classification?: ClassificationData;
  quality?: QualityData;
  denoising?: { applied: boolean };
  timings_ms?: Partial<Record<StepId, number>>;
  total_ms?: number;
}

export type ServerErrorCode =
  | 'INVALID_IMAGE'
  | 'INVALID_PARAMETER'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'SERVER_BUSY'
  | 'MODEL_NOT_READY'
  | 'NOT_A_PHOTO'
  | 'INTERNAL_ERROR'
  // v1.1 (batch)
  | 'TOO_MANY_FILES'
  | 'BATCH_TOO_LARGE'
  | 'BATCH_TIMEOUT';

export type ClientErrorCode = 'CONNECTION_LOST' | 'TIMEOUT' | 'SERVER_OFFLINE' | 'HTTP_ERROR';

export type ErrorCode = ServerErrorCode | ClientErrorCode;

export interface ErrorBody {
  code: string;
  message?: string;
  step?: StepId;
  request_id?: string;
  details?: Record<string, unknown>;
}

export interface ErrorEvent extends ErrorBody {
  event: 'error';
}

export type StreamEvent = StartedEvent | StepEvent | ResultEvent | ErrorEvent;

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value);
}

/** Light structural check: we trust the contract, but never crash on junk. */
export function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.event) {
    case 'started':
      return true;
    case 'step':
      return (
        isStepId(v.step) &&
        (v.status === 'running' || v.status === 'done' || v.status === 'skipped')
      );
    case 'result':
      return typeof v.caption === 'string';
    case 'error':
      return typeof v.code === 'string';
    default:
      return false;
  }
}

// ---- v1.1: POST /v1/batch stream events -------------------------------------

/** Batch stages: the v1 step names except validation (done before batch_started). */
export const STAGE_IDS = [
  'classification',
  'quality',
  'denoising',
  'reclassification',
  'captioning',
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export interface BatchStartedItem {
  index: number;
  filename: string;
  bytes: number;
  width?: number;
  height?: number;
  format?: string;
  status: 'accepted' | 'rejected';
  error?: ErrorBody;
}

export interface BatchStartedEvent {
  event: 'batch_started';
  request_id: string;
  count: number;
  items: BatchStartedItem[];
}

export interface StageEvent {
  event: 'stage';
  stage: StageId;
  status: 'running' | 'done';
  count?: number;
  elapsed_ms?: number;
}

export type ItemStepEvent = {
  [K in StepId]: {
    event: 'item_step';
    index: number;
    step: K;
    status: 'running' | 'done' | 'skipped';
    data?: StepDataMap[K];
  };
}[StepId];

export interface BatchItemOk {
  index: number;
  filename?: string;
  status: 'ok';
  caption: string;
  classification?: ClassificationData;
  quality?: QualityData;
  denoising?: { applied: boolean };
}

export interface BatchItemError {
  index: number;
  filename?: string;
  status: 'error';
  error: ErrorBody;
}

export type BatchItemResult = BatchItemOk | BatchItemError;

export type ItemDoneEvent = { event: 'item_done' } & BatchItemResult;

export interface HeartbeatEvent {
  event: 'heartbeat';
  t?: number;
}

export interface BatchResultEvent {
  event: 'batch_result';
  request_id?: string;
  count?: number;
  succeeded?: number;
  failed?: number;
  timings_ms?: Partial<Record<StageId, number>>;
  total_ms?: number;
  items: BatchItemResult[];
}

export type BatchStreamEvent =
  | BatchStartedEvent
  | StageEvent
  | ItemStepEvent
  | ItemDoneEvent
  | HeartbeatEvent
  | BatchResultEvent
  | ErrorEvent;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function isStageId(value: unknown): value is StageId {
  return typeof value === 'string' && (STAGE_IDS as readonly string[]).includes(value);
}

function isItemResult(v: unknown): v is BatchItemResult {
  if (!isObject(v) || !isIndex(v.index)) return false;
  if (v.status === 'ok') return typeof v.caption === 'string';
  if (v.status === 'error') return isObject(v.error) && typeof v.error.code === 'string';
  return false;
}

/**
 * Structural check for batch stream lines. Unknown `event` values (and
 * malformed known ones) return false so callers can ignore them; unknown
 * fields are simply carried along.
 */
export function isBatchStreamEvent(value: unknown): value is BatchStreamEvent {
  if (!isObject(value)) return false;
  switch (value.event) {
    case 'batch_started':
      return Array.isArray(value.items) && value.items.every((i) => isObject(i) && isIndex(i.index));
    case 'stage':
      return isStageId(value.stage) && (value.status === 'running' || value.status === 'done');
    case 'item_step':
      return (
        isIndex(value.index) &&
        isStepId(value.step) &&
        (value.status === 'running' || value.status === 'done' || value.status === 'skipped')
      );
    case 'item_done':
      return isItemResult(value);
    case 'heartbeat':
      return true;
    case 'batch_result':
      return Array.isArray(value.items) && value.items.every(isItemResult);
    case 'error':
      return typeof value.code === 'string';
    default:
      return false;
  }
}
