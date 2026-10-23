import { describe, expect, it } from 'vitest';
import { flushNdjson, parseNdjsonChunk, readNdjson, type NdjsonItem } from './ndjson';

function values(items: NdjsonItem[]) {
  return items.filter((i) => i.ok).map((i) => (i as { value: unknown }).value);
}

describe('parseNdjsonChunk', () => {
  it('parses one complete line', () => {
    const r = parseNdjsonChunk('', '{"a":1}\n');
    expect(values(r.items)).toEqual([{ a: 1 }]);
    expect(r.buffer).toBe('');
  });

  it('keeps a line split across chunks in the buffer until it is complete', () => {
    const first = parseNdjsonChunk('', '{"event":"st');
    expect(first.items).toEqual([]);
    expect(first.buffer).toBe('{"event":"st');
    const second = parseNdjsonChunk(first.buffer, 'arted"}\n{"b"');
    expect(values(second.items)).toEqual([{ event: 'started' }]);
    expect(second.buffer).toBe('{"b"');
    const third = parseNdjsonChunk(second.buffer, ':2}\n');
    expect(values(third.items)).toEqual([{ b: 2 }]);
  });

  it('returns every event of a multi-event chunk in order', () => {
    const r = parseNdjsonChunk('', '{"n":1}\n{"n":2}\n{"n":3}\n{"n":');
    expect(values(r.items)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(r.buffer).toBe('{"n":');
  });

  it('ignores blank and whitespace-only lines, including CRLF', () => {
    const r = parseNdjsonChunk('', '\n\n{"a":1}\r\n   \n\r\n{"a":2}\n');
    expect(r.items).toHaveLength(2);
    expect(values(r.items)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('reports an invalid JSON line without dropping the following ones', () => {
    const r = parseNdjsonChunk('', '{"a":1}\nnot json\n{"a":2}\n');
    expect(r.items).toHaveLength(3);
    expect(r.items[1]).toMatchObject({ ok: false, line: 'not json' });
    expect(values(r.items)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('flushNdjson', () => {
  it('parses trailing data without a final newline', () => {
    expect(values(flushNdjson('{"event":"result"}'))).toEqual([{ event: 'result' }]);
  });
  it('returns nothing for an empty or blank buffer', () => {
    expect(flushNdjson('')).toEqual([]);
    expect(flushNdjson('  \r')).toEqual([]);
  });
  it('reports invalid trailing data', () => {
    expect(flushNdjson('{"trunc')[0]).toMatchObject({ ok: false });
  });
});

describe('readNdjson', () => {
  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c) {
        chunks.forEach((ch) => c.enqueue(ch));
        c.close();
      },
    });
  }

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"caption":"café"}\n{"x":1}');
    // Cut in the middle of the two-byte "é".
    const cut = bytes.indexOf(0xc3) + 1;
    const out: unknown[] = [];
    for await (const item of readNdjson(streamOf([bytes.slice(0, cut), bytes.slice(cut)]))) {
      if (item.ok) out.push(item.value);
    }
    expect(out).toEqual([{ caption: 'café' }, { x: 1 }]);
  });
});
