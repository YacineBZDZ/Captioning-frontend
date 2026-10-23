// Newline-delimited JSON parsing.
//
// `parseNdjsonChunk` is a pure function: feed it the leftover buffer from the
// previous call plus a new decoded text chunk; it returns every complete line
// parsed, plus the new leftover. `flushNdjson` handles trailing data without a
// final newline when the stream ends.

export type NdjsonItem = { ok: true; value: unknown } | { ok: false; line: string; error: string };

export interface NdjsonChunkResult {
  items: NdjsonItem[];
  buffer: string;
}

function parseLine(raw: string): NdjsonItem | null {
  const line = raw.trim();
  if (line === '') return null;
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch (err) {
    return { ok: false, line, error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseNdjsonChunk(buffer: string, chunk: string): NdjsonChunkResult {
  const text = buffer + chunk;
  const parts = text.split('\n');
  const rest = parts.pop() ?? '';
  const items: NdjsonItem[] = [];
  for (const part of parts) {
    const item = parseLine(part);
    if (item) items.push(item);
  }
  return { items, buffer: rest };
}

export function flushNdjson(buffer: string): NdjsonItem[] {
  const item = parseLine(buffer);
  return item ? [item] : [];
}

/** Reads a byte stream and yields each parsed NDJSON line as it arrives. */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<NdjsonItem> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const result = parseNdjsonChunk(buffer, decoder.decode(value, { stream: true }));
      buffer = result.buffer;
      yield* result.items;
    }
    yield* flushNdjson(buffer + decoder.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Lock already released (stream errored or was cancelled).
    }
  }
}
