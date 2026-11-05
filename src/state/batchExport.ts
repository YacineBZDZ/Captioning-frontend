// Client-side exports of batch results. Nothing leaves the browser: files are
// built as Blobs and handed to the user through a temporary object URL.

import type { BatchItem } from './batch';

export type ExportItem = Pick<
  BatchItem,
  'index' | 'filename' | 'outcome' | 'caption' | 'classification' | 'denoised' | 'error'
>;

export type ExportStatus = 'ok' | 'not_a_photo' | 'error' | 'cancelled' | 'interrupted' | 'pending';

export function exportStatus(item: ExportItem): ExportStatus {
  if (item.outcome === 'done') return 'ok';
  return item.outcome ?? 'pending';
}

export const CSV_COLUMNS = [
  'filename',
  'status',
  'predicted_class',
  'confidence',
  'denoised',
  'caption',
  'error_code',
] as const;

/**
 * One CSV cell: neutralises spreadsheet formulas (a leading = + - @, tab or
 * carriage return gets an apostrophe), then quotes when needed (RFC 4180).
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(item: ExportItem): (string | number | boolean | undefined)[] {
  const ok = item.outcome === 'done';
  return [
    item.filename,
    exportStatus(item),
    item.classification?.predicted_class,
    item.classification ? Math.round(item.classification.confidence * 10000) / 10000 : undefined,
    item.outcome === 'done' || item.outcome === 'not_a_photo' ? item.denoised : undefined,
    ok ? item.caption : undefined, // never a caption for a rejected image
    ok ? undefined : item.error?.code,
  ];
}

/** UTF-8 CSV with a byte-order mark (so spreadsheet apps detect UTF-8) and CRLF line ends. */
export function toCsv(items: readonly ExportItem[]): string {
  const lines = [CSV_COLUMNS.join(','), ...items.map((i) => row(i).map(csvCell).join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function toJson(items: readonly ExportItem[]): string {
  return JSON.stringify(
    {
      count: items.length,
      captioned: items.filter((i) => i.outcome === 'done').length,
      items: items.map((i) => ({
        index: i.index,
        filename: i.filename,
        status: exportStatus(i),
        predicted_class: i.classification?.predicted_class ?? null,
        confidence: i.classification?.confidence ?? null,
        denoised: i.outcome === 'done' || i.outcome === 'not_a_photo' ? i.denoised : null,
        caption: i.outcome === 'done' ? (i.caption ?? null) : null,
        error:
          i.outcome !== 'done' && i.error
            ? { code: i.error.code, message: i.error.serverMessage ?? null }
            : null,
      })),
    },
    null,
    2,
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** "filename: caption", one line per captioned image (line breaks are flattened). */
export function captionsText(items: readonly ExportItem[]): string {
  return items
    .filter((i) => i.outcome === 'done' && i.caption)
    .map((i) => `${oneLine(i.filename)}: ${oneLine(i.caption!)}`)
    .join('\n');
}

/** Saves text as a file through a temporary object URL, revoked right after. */
export function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
