// Plain-language text for the batch view and its announcements.

import { describeError, notAPhotoSentence, type ErrorContext } from '../api/errors';
import type { ClassificationData, StageId } from '../api/types';
import { pct } from '../format';
import type { BatchItem, BatchSummary, ItemStatus, StripStage } from './batch';

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  waiting: 'Waiting',
  classifying: 'Classifying',
  checking: 'Checking quality',
  cleaning: 'Cleaning',
  rechecking: 'Re-checking',
  captioning: 'Writing caption',
  done: 'Done',
  not_a_photo: 'Not a photo',
  error: 'Error',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export const STRIP_LABEL: Record<StripStage, string> = {
  upload: 'Upload',
  classification: 'Classification',
  quality: 'Quality',
  denoising: 'Denoising',
  reclassification: 'Re-check',
  captioning: 'Captioning',
};

export const STAGE_FINISHED: Record<StageId, string> = {
  classification: 'Classification finished',
  quality: 'Quality check finished',
  denoising: 'Denoising finished',
  reclassification: 'Re-check finished',
  captioning: 'Captioning finished',
};

/** Latest known classification of an item, as soon as one exists. */
export function liveClassification(item: BatchItem): ClassificationData | undefined {
  return (
    item.classification ??
    item.run.steps.reclassification.data ??
    item.run.steps.classification.data
  );
}

export function classBadge(item: BatchItem): string | null {
  const c = liveClassification(item);
  return c ? `${c.predicted_class} ${pct(c.confidence)}` : null;
}

export function isDenoised(item: BatchItem): boolean {
  const d = item.run.steps.denoising.data;
  return item.denoised || (d?.applied ?? false);
}

/** The one-line message of a card that has no caption. */
export function itemMessage(item: BatchItem, ctx: ErrorContext): string | null {
  switch (item.outcome) {
    case 'not_a_photo': {
      const rechecked = item.error?.details?.rechecked === true;
      return `${notAPhotoSentence(item.error?.details)}${rechecked ? ' Checked again after cleaning.' : ''}`;
    }
    case 'error':
      if (!item.error) return 'Something went wrong.';
      if (item.error.code === 'BATCH_TIMEOUT') return describeError(item.error, ctx).message;
      return `${describeError(item.error, ctx).title}.`;
    case 'interrupted':
      return item.error
        ? `Not finished: ${describeError(item.error, ctx).title.toLowerCase()}.`
        : 'Not finished.';
    case 'cancelled':
      return 'Cancelled before it was processed.';
    default:
      return null;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "9 captioned, 2 not photos, 1 error". */
export function summaryText(s: BatchSummary): string {
  const parts = [`${s.captioned} captioned`];
  if (s.notPhotos) parts.push(plural(s.notPhotos, 'not a photo', 'not photos'));
  if (s.errors) parts.push(plural(s.errors, 'error', 'errors'));
  if (s.interrupted) parts.push(`${s.interrupted} interrupted`);
  if (s.cancelled) parts.push(`${s.cancelled} cancelled`);
  return parts.join(', ');
}
