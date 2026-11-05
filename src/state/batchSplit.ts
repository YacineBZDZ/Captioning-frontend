// Splits a selection into consecutive groups that each respect the server's
// batch limits, so a large selection never has to be refused.

import type { BatchLimits } from '../api/client';

/** Hard client-side cap on a selection, whatever the server allows. */
export const HARD_CAP = 200;

export interface SplitLimits {
  maxImages: number;
  maxTotalBytes: number;
}

export function splitLimits(batch: BatchLimits): SplitLimits {
  return {
    maxImages: Math.max(1, Math.floor(batch.maxImages)),
    maxTotalBytes: batch.maxTotalMb * 1024 * 1024,
  };
}

/**
 * Greedy, order-preserving split. A group is closed when the next item would
 * exceed either limit. An item larger than `maxTotalBytes` on its own still
 * gets a group of its own (the server then reports it per item).
 */
export function splitIntoGroups<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  limits: SplitLimits,
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    const full =
      current.length >= limits.maxImages ||
      (current.length > 0 && bytes + size > limits.maxTotalBytes);
    if (full) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Applies HARD_CAP when adding `incoming` to a selection that already has `existing` items. */
export function capSelection<T>(
  existing: number,
  incoming: readonly T[],
  cap = HARD_CAP,
): { accepted: T[]; dropped: number } {
  const room = Math.max(0, cap - existing);
  return { accepted: incoming.slice(0, room), dropped: Math.max(0, incoming.length - room) };
}

/**
 * Limits for "Retry with smaller groups" after TOO_MANY_FILES or
 * BATCH_TOO_LARGE: the tightest of the re-read /v1/info limits and the
 * limits named in the error details. If that is still not smaller than the
 * group that failed, the group size is halved.
 */
export function smallerLimits(
  fresh: SplitLimits,
  details: Record<string, unknown> | undefined,
  failedGroup: { count: number; bytes: number },
): SplitLimits {
  let maxImages = fresh.maxImages;
  let maxTotalBytes = fresh.maxTotalBytes;
  if (typeof details?.max_images === 'number' && details.max_images > 0)
    maxImages = Math.min(maxImages, Math.floor(details.max_images));
  if (typeof details?.max_total_mb === 'number' && details.max_total_mb > 0)
    maxTotalBytes = Math.min(maxTotalBytes, details.max_total_mb * 1024 * 1024);
  const fits = failedGroup.count <= maxImages && failedGroup.bytes <= maxTotalBytes;
  if (fits) maxImages = Math.min(maxImages, Math.ceil(failedGroup.count / 2));
  return { maxImages: Math.max(1, maxImages), maxTotalBytes };
}
