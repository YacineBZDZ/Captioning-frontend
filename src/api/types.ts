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
  | 'INTERNAL_ERROR';

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
