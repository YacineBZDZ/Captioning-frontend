// Plain-language text for each step, shared by the timeline and the live region.

import type { ServerInfo } from '../api/client';
import type { ClassificationData, QualityData, StepId } from '../api/types';
import { formatBytes, formatDims, pct } from '../format';
import type { RunPhase, StepState, StepStatus } from './pipeline';

export interface StepMeta {
  title: string;
  model?: (info: ServerInfo) => string;
}

export const STEP_META: Record<StepId, StepMeta> = {
  validation: { title: 'Reading the image' },
  classification: { title: 'Is it a photograph?', model: (i) => i.models.classifier },
  quality: { title: 'Checking noise and blur' },
  denoising: { title: 'Cleaning the image', model: (i) => `U-Net ${i.models.denoiser}` },
  reclassification: { title: 'Re-checking after cleaning', model: (i) => i.models.classifier },
  captioning: { title: 'Writing the caption', model: (i) => i.models.captioner },
};

export const STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  error: 'Failed',
  not_needed: 'Not needed',
};

export const QUALITY_LABEL: Record<QualityData['reason'], string> = {
  clean: 'Clean',
  noisy: 'Noisy',
  blurry: 'Blurry',
  noisy_and_blurry: 'Noisy and blurry',
};

export function classificationSummary(d: ClassificationData): string {
  return `${d.predicted_class} – ${pct(d.confidence)}`;
}

/** Waiting for the terminal event after a step said "not a photo". */
export const NOT_A_PHOTO_PENDING = 'Not a photo – checking whether noise is hiding it…';

/** True when a classification says "not a photo" but the run continues. */
export function isProvisionalNonPhoto(step: StepState, phase: RunPhase): boolean {
  const d = step.data as ClassificationData | undefined;
  return step.status === 'done' && d?.is_photo === false && phase === 'running';
}

export function stepSummary(id: StepId, step: StepState, phase: RunPhase): string {
  switch (step.status) {
    case 'pending':
      return phase === 'running' ? 'Waiting' : '—';
    case 'running':
      return 'Working…';
    case 'not_needed':
      return 'Not needed for this image';
    default:
      break;
  }

  switch (id) {
    case 'validation': {
      const d = step.data as
        { width: number; height: number; format: string; bytes: number } | undefined;
      return d
        ? `${formatDims(d.width, d.height)} ${d.format}, ${formatBytes(d.bytes)}`
        : 'Image read';
    }
    case 'classification':
    case 'reclassification': {
      const d = step.data as ClassificationData | undefined;
      if (!d) return step.status === 'error' ? 'Not a photograph' : 'Classified';
      if (isProvisionalNonPhoto(step, phase))
        return `${classificationSummary(d)}. ${NOT_A_PHOTO_PENDING}`;
      if (!d.is_photo && step.status !== 'error' && phase === 'success')
        return `${classificationSummary(d)} at first, recovered after cleaning`;
      return classificationSummary(d);
    }
    case 'quality': {
      const d = step.data as QualityData | undefined;
      if (!d) return 'Checked';
      return `${QUALITY_LABEL[d.reason] ?? d.reason} – noise ${d.noise_sigma.toFixed(3)}, sharpness ${d.sharpness.toFixed(1)}`;
    }
    case 'denoising': {
      const d = step.data as
        { applied: boolean; reason?: string; width?: number; height?: number } | undefined;
      if (!d) return step.status === 'skipped' ? 'Skipped' : 'Cleaned';
      if (d.applied)
        return d.width && d.height
          ? `Cleaned – ${formatDims(d.width, d.height)} preview`
          : 'Cleaned';
      if (d.reason === 'clean') return 'Image is already clean';
      if (d.reason === 'disabled_by_request') return 'Disabled by you';
      return `Skipped (${d.reason ?? 'no reason given'})`;
    }
    case 'captioning': {
      const d = step.data as { caption: string } | undefined;
      return d ? `“${d.caption}”` : 'Caption written';
    }
  }
}
