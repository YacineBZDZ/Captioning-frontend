import type { ServerInfo } from './api/client';
import { formatTypes } from './api/errors';
import { formatBytes } from './format';

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function typeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? '';
}

/** Client-side checks before upload. Returns a message, or null when acceptable. */
export function validateFile(file: File, info: ServerInfo): string | null {
  const type = typeOf(file);
  if (!info.allowedTypes.includes(type)) {
    return `“${file.name}” is not a supported image type. Use ${formatTypes(info.allowedTypes)}.`;
  }
  if (file.size > info.maxUploadMb * 1024 * 1024) {
    return `“${file.name}” is ${formatBytes(file.size)}; the limit is ${info.maxUploadMb} MB.`;
  }
  if (file.size === 0) return `“${file.name}” is empty.`;
  return null;
}
