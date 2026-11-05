import { describe, expect, it } from 'vitest';
import { capSelection, HARD_CAP, smallerLimits, splitIntoGroups, splitLimits } from './batchSplit';

const MB = 1024 * 1024;
const files = (sizesMb: number[]) => sizesMb.map((mb, i) => ({ id: i, size: mb * MB }));
const ids = (groups: { id: number }[][]) => groups.map((g) => g.map((f) => f.id));
const size = (f: { size: number }) => f.size;

describe('splitIntoGroups', () => {
  const limits = splitLimits({ maxImages: 20, maxTotalMb: 60 });

  it('keeps a selection within the limits in one group', () => {
    expect(ids(splitIntoGroups(files([1, 2, 3]), size, limits))).toEqual([[0, 1, 2]]);
  });

  it('splits 45 small images into 20 + 20 + 5, in order', () => {
    const groups = splitIntoGroups(files(Array(45).fill(0.5)), size, limits);
    expect(groups.map((g) => g.length)).toEqual([20, 20, 5]);
    expect(ids(groups).flat()).toEqual([...Array(45).keys()]);
  });

  it('respects max_total_mb', () => {
    // 7 × 9 MB = 63 MB > 60 MB: the 7th starts a new group.
    const groups = splitIntoGroups(files(Array(7).fill(9)), size, limits);
    expect(groups.map((g) => g.length)).toEqual([6, 1]);
    groups.forEach((g) => expect(g.reduce((s, f) => s + f.size, 0)).toBeLessThanOrEqual(60 * MB));
  });

  it('respects both limits at once and keeps the original order', () => {
    const small = splitLimits({ maxImages: 3, maxTotalMb: 10 });
    const groups = splitIntoGroups(files([4, 4, 1, 1, 1, 1, 6, 5]), size, small);
    expect(ids(groups)).toEqual([[0, 1, 2], [3, 4, 5], [6], [7]]);
  });

  it('puts an image larger than max_total_mb alone in its group', () => {
    const small = splitLimits({ maxImages: 20, maxTotalMb: 5 });
    expect(ids(splitIntoGroups(files([1, 8, 1, 1]), size, small))).toEqual([[0], [1], [2, 3]]);
  });

  it('returns no group for an empty selection', () => {
    expect(splitIntoGroups([], size, limits)).toEqual([]);
  });
});

describe('capSelection (200 images)', () => {
  it('accepts everything below the cap', () => {
    expect(capSelection(10, [1, 2, 3])).toEqual({ accepted: [1, 2, 3], dropped: 0 });
  });

  it('accepts only what fits under 200 and counts the rest', () => {
    const incoming = [...Array(50).keys()];
    const r = capSelection(180, incoming);
    expect(r.accepted).toHaveLength(20);
    expect(r.accepted[19]).toBe(19);
    expect(r.dropped).toBe(30);
    expect(HARD_CAP).toBe(200);
  });

  it('accepts nothing once the selection is full', () => {
    expect(capSelection(200, [1])).toEqual({ accepted: [], dropped: 1 });
  });
});

describe('smallerLimits', () => {
  const fresh = splitLimits({ maxImages: 20, maxTotalMb: 60 });

  it('uses the limits named in the error details', () => {
    expect(smallerLimits(fresh, { max_images: 5, received: 8 }, { count: 8, bytes: MB })).toEqual({
      maxImages: 5,
      maxTotalBytes: 60 * MB,
    });
    expect(
      smallerLimits(fresh, { max_total_mb: 30 }, { count: 10, bytes: 50 * MB }).maxTotalBytes,
    ).toBe(30 * MB);
  });

  it('uses the re-read /v1/info limits when they are smaller', () => {
    const reread = splitLimits({ maxImages: 4, maxTotalMb: 60 });
    expect(smallerLimits(reread, undefined, { count: 8, bytes: MB }).maxImages).toBe(4);
  });

  it('halves the group when nothing says what the real limit is', () => {
    expect(smallerLimits(fresh, undefined, { count: 8, bytes: MB }).maxImages).toBe(4);
    expect(smallerLimits(fresh, undefined, { count: 1, bytes: MB }).maxImages).toBe(1);
  });
});
