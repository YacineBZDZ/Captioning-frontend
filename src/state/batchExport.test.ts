import { describe, expect, it } from 'vitest';
import type { ClassificationData } from '../api/types';
import { captionsText, csvCell, toCsv, toJson, type ExportItem } from './batchExport';

const cls = (name: string, confidence: number): ClassificationData => ({
  predicted_class: name,
  confidence,
  probabilities: {},
  is_photo: name === 'Photo',
  photo_threshold: 0.5,
  input: 'original',
});

const items: ExportItem[] = [
  {
    index: 0,
    filename: 'beach, day 1.jpg',
    outcome: 'done',
    caption: 'a dog "running"\non the beach',
    classification: cls('Photo', 0.97),
    denoised: true,
  },
  {
    index: 1,
    filename: '=cmd|calc.jpg',
    outcome: 'not_a_photo',
    caption: 'must never be exported',
    classification: cls('Painting', 0.93),
    denoised: false,
    error: { code: 'NOT_A_PHOTO', serverMessage: 'looks like a painting' },
  },
  {
    index: 2,
    filename: 'bad.jpg',
    outcome: 'error',
    denoised: false,
    error: { code: 'INVALID_IMAGE' },
  },
  { index: 3, filename: 'late.jpg', outcome: 'cancelled', denoised: false },
];

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\r')).toBe('"cr\r"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0.97)).toBe('0.97');
  });

  it('neutralises formula injection', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    expect(csvCell('a=b')).toBe('a=b');
  });
});

describe('toCsv', () => {
  const csv = toCsv(items);

  it('starts with a UTF-8 BOM and the header', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')[0]).toBe(
      'filename,status,predicted_class,confidence,denoised,caption,error_code',
    );
  });

  it('writes one escaped row per item, and never a caption for rejected images', () => {
    expect(csv).toContain(
      '"beach, day 1.jpg",ok,Photo,0.97,true,"a dog ""running""\non the beach",\r\n',
    );
    expect(csv).toContain("'=cmd|calc.jpg,not_a_photo,Painting,0.93,false,,NOT_A_PHOTO\r\n");
    expect(csv).toContain('bad.jpg,error,,,,,INVALID_IMAGE\r\n');
    expect(csv).toContain('late.jpg,cancelled,,,,,\r\n');
    expect(csv).not.toContain('must never be exported');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('toJson', () => {
  it('lists every item in order with status, class, caption and error', () => {
    const data = JSON.parse(toJson(items));
    expect(data.count).toBe(4);
    expect(data.captioned).toBe(1);
    expect(data.items.map((i: { filename: string }) => i.filename)).toEqual([
      'beach, day 1.jpg',
      '=cmd|calc.jpg',
      'bad.jpg',
      'late.jpg',
    ]);
    expect(data.items[0]).toEqual({
      index: 0,
      filename: 'beach, day 1.jpg',
      status: 'ok',
      predicted_class: 'Photo',
      confidence: 0.97,
      denoised: true,
      caption: 'a dog "running"\non the beach',
      error: null,
    });
    expect(data.items[1]).toMatchObject({
      status: 'not_a_photo',
      caption: null,
      error: { code: 'NOT_A_PHOTO', message: 'looks like a painting' },
    });
    expect(data.items[3]).toMatchObject({ status: 'cancelled', error: null, caption: null });
  });
});

describe('captionsText', () => {
  it('has one "filename: caption" line per captioned image only', () => {
    expect(captionsText(items)).toBe('beach, day 1.jpg: a dog "running" on the beach');
    const two: ExportItem[] = [
      { ...items[0]!, filename: 'a.jpg', caption: 'one' },
      items[2]!,
      { ...items[0]!, filename: 'b.jpg', caption: 'two' },
    ];
    expect(captionsText(two)).toBe('a.jpg: one\nb.jpg: two');
  });
});
