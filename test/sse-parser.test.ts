import { describe, expect, it } from 'vitest';
import {
  SseParser,
  SseBufferOverflowError,
  interpretChatChunk,
  type SseEvent,
} from '../src/upstream/sse-parser.js';

const MIB = 1_048_576;

/** Прогнать чанки через парсер и собрать всё, включая flush. */
function parseAll(chunks: Array<Buffer | string>, parser = new SseParser()): SseEvent[] {
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...parser.push(c));
  out.push(...parser.flush());
  return out;
}

/** Разрезать байтовую строку на чанки по одному байту. */
function byteChunks(text: string): Buffer[] {
  const buf = Buffer.from(text, 'utf8');
  return Array.from({ length: buf.length }, (_, i) => buf.subarray(i, i + 1));
}

describe('SseParser', () => {
  it('parses a single complete event', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n\n')).toEqual([{ data: '{"a":1}' }]);
    expect(p.flush()).toEqual([]);
  });

  it('returns nothing for an empty or incomplete chunk', () => {
    const p = new SseParser();
    expect(p.push('')).toEqual([]);
    expect(p.push(Buffer.alloc(0))).toEqual([]);
    expect(p.push('data: {"a"')).toEqual([]);
  });

  it('reassembles an event split into three chunks in the middle of JSON', () => {
    const p = new SseParser();
    expect(p.push('data: {"choices":[{"del')).toEqual([]);
    expect(p.push('ta":{"content":"hi"}}]')).toEqual([]);
    expect(p.push('}\n\ndata: next\n\n')).toEqual([
      { data: '{"choices":[{"delta":{"content":"hi"}}]}' },
      { data: 'next' },
    ]);
  });

  it('decodes multi-byte UTF-8 split across chunk boundaries', () => {
    const text = 'data: {"t":"тест 🙂"}\n\n';
    expect(parseAll(byteChunks(text))).toEqual([{ data: '{"t":"тест 🙂"}' }]);

    // Разрез ровно посередине двухбайтового символа.
    const buf = Buffer.from('data: тест\n\n', 'utf8');
    const cut = buf.indexOf(Buffer.from('т', 'utf8')) + 1;
    expect(parseAll([buf.subarray(0, cut), buf.subarray(cut)])).toEqual([{ data: 'тест' }]);
  });

  it('accepts CRLF and CR line endings', () => {
    expect(parseAll(['data: a\r\n\r\ndata: b\r\n\r\n'])).toEqual([{ data: 'a' }, { data: 'b' }]);
    expect(parseAll(['data: a\r\rdata: b\r\r'])).toEqual([{ data: 'a' }, { data: 'b' }]);
    // Смешанные окончания внутри одного события.
    expect(parseAll(['data: a\r\ndata: b\rdata: c\n\n'])).toEqual([{ data: 'a\nb\nc' }]);
  });

  it('does not treat CR + LF from adjacent chunks as two line breaks', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\ndata: b\r\n\r\n')).toEqual([{ data: 'a\nb' }]);
    // А одинокий `\r` перед следующей строкой — обычный конец строки.
    expect(p.push('data: c\r')).toEqual([]);
    expect(p.push('data: d\r\r')).toEqual([{ data: 'c\nd' }]);
  });

  it('dispatches on a trailing CR-terminated blank line without waiting for the next chunk', () => {
    const p = new SseParser();
    expect(p.push('data: a\r\r')).toEqual([{ data: 'a' }]);
    // Пришедший следом `\n` (хвост `\r\n`) не порождает лишнего события и не ломает следующее.
    expect(p.push('\n')).toEqual([]);
    expect(p.push('id: 2\ndata: b\n\n')).toEqual([{ data: 'b', id: '2' }]);
  });

  it('ignores comments and events without data', () => {
    expect(parseAll([': OPENROUTER PROCESSING\n\n'])).toEqual([]);
    expect(parseAll([': OPENROUTER PROCESSING\n', ': OPENROUTER PROCESSING\n', 'data: x\n\n'])).toEqual([
      { data: 'x' },
    ]);
    expect(parseAll(['event: ping\n\n'])).toEqual([]);
    expect(parseAll(['event: ping\nid: 7\n\n'])).toEqual([]);
  });

  it('drops event/id of a dataless event instead of leaking them into the next one', () => {
    expect(parseAll(['event: ping\nid: 7\n\ndata: x\n\n'])).toEqual([{ data: 'x' }]);
  });

  it('carries event and id fields', () => {
    expect(parseAll(['id: 1\nevent: msg\ndata: x\n\n'])).toEqual([{ data: 'x', event: 'msg', id: '1' }]);
    // Поле id с NUL по спецификации игнорируется.
    expect(parseAll(['id: a\0b\ndata: x\n\n'])).toEqual([{ data: 'x' }]);
  });

  it('joins multiple data lines with LF', () => {
    expect(parseAll(['data: a\ndata: b\ndata: c\n\n'])).toEqual([{ data: 'a\nb\nc' }]);
    // `data` без двоеточия — пустая data-строка.
    expect(parseAll(['data\ndata: x\n\n'])).toEqual([{ data: '\nx' }]);
    expect(parseAll(['data\n\n'])).toEqual([{ data: '' }]);
  });

  it('strips exactly one space after the colon', () => {
    expect(parseAll(['data:x\n\n'])).toEqual([{ data: 'x' }]);
    expect(parseAll(['data: x\n\n'])).toEqual([{ data: 'x' }]);
    expect(parseAll(['data:  two spaces\n\n'])).toEqual([{ data: ' two spaces' }]);
    expect(parseAll(['data: a: b\n\n'])).toEqual([{ data: 'a: b' }]);
  });

  it('ignores unknown fields and retry', () => {
    expect(parseAll(['retry: 1000\nfoo: bar\ndata: x\nbaz\n\n'])).toEqual([{ data: 'x' }]);
  });

  it('flush() returns the trailing event without a final blank line, only once', () => {
    const p = new SseParser();
    expect(p.push('data: a\n\ndata: b')).toEqual([{ data: 'a' }]);
    expect(p.flush()).toEqual([{ data: 'b' }]);
    expect(p.flush()).toEqual([]);
  });

  it('flush() handles a trailing CR and a trailing partial UTF-8 sequence', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.flush()).toEqual([{ data: 'a' }]);

    const q = new SseParser();
    q.push(Buffer.from('data: ab', 'utf8'));
    q.push(Buffer.from([0xd1])); // первая половина «т»
    const [ev] = q.flush();
    expect(ev?.data.startsWith('ab')).toBe(true);
    expect(ev?.data.length).toBe(3); // «ab» + символ замены
  });

  it('flush() returns nothing when there is no pending data', () => {
    const p = new SseParser();
    p.push('data: a\n\n');
    expect(p.flush()).toEqual([]);
    expect(new SseParser().flush()).toEqual([]);
    const q = new SseParser();
    q.push('event: ping');
    expect(q.flush()).toEqual([]);
  });

  it('strips a leading BOM', () => {
    expect(parseAll([Buffer.from('﻿data: x\n\n', 'utf8')])).toEqual([{ data: 'x' }]);
  });

  it('throws SseBufferOverflowError for a 2 MiB chunk without separators at a 1 MiB limit', () => {
    const p = new SseParser(MIB);
    expect(() => p.push(Buffer.alloc(2 * MIB, 'a'))).toThrow(SseBufferOverflowError);
    try {
      new SseParser(MIB).push('b'.repeat(2 * MIB));
    } catch (e) {
      expect(e).toBeInstanceOf(SseBufferOverflowError);
      expect((e as SseBufferOverflowError).limit).toBe(MIB);
      expect((e as Error).name).toBe('SseBufferOverflowError');
    }
  });

  it('throws when the unterminated tail grows past the limit gradually', () => {
    const p = new SseParser(MIB);
    const half = Buffer.alloc(MIB / 2, 'a');
    expect(p.push(half)).toEqual([]);
    expect(p.push(half)).toEqual([]); // ровно лимит — ещё допустимо
    expect(() => p.push(Buffer.from('a'))).toThrow(SseBufferOverflowError);
  });

  it('counts accumulated data lines without a blank line toward the limit', () => {
    const p = new SseParser(1024);
    const line = `data: ${'x'.repeat(100)}\n`;
    expect(() => {
      for (let i = 0; i < 20; i++) p.push(line);
    }).toThrow(SseBufferOverflowError);
  });

  it('counts bytes, not UTF-16 code units', () => {
    // 400 символов по 2 байта = 800 байт > 700, хотя длина строки меньше лимита.
    const p = new SseParser(700);
    expect(() => p.push('т'.repeat(400))).toThrow(SseBufferOverflowError);
  });

  it('does not throw for a large event that fits within the limit', () => {
    const p = new SseParser(MIB);
    const payload = 'x'.repeat(MIB - 100);
    expect(p.push(`data: ${payload}\n\n`)).toEqual([{ data: payload }]);
    // После доставки буфер пуст — можно снова принимать большие события.
    expect(p.push(`data: ${payload}\n\n`)).toEqual([{ data: payload }]);
  });
});

describe('interpretChatChunk', () => {
  const ev = (data: string): SseEvent => ({ data });

  it('recognizes [DONE], including surrounding whitespace', () => {
    expect(interpretChatChunk(ev('[DONE]'))).toEqual({ kind: 'done' });
    expect(interpretChatChunk(ev(' [DONE] '))).toEqual({ kind: 'done' });
  });

  it('treats garbage, non-objects and arrays as opaque', () => {
    expect(interpretChatChunk(ev('not json'))).toEqual({ kind: 'opaque' });
    expect(interpretChatChunk(ev(''))).toEqual({ kind: 'opaque' });
    expect(interpretChatChunk(ev('42'))).toEqual({ kind: 'opaque' });
    expect(interpretChatChunk(ev('"str"'))).toEqual({ kind: 'opaque' });
    expect(interpretChatChunk(ev('null'))).toEqual({ kind: 'opaque' });
    expect(interpretChatChunk(ev('[1,2]'))).toEqual({ kind: 'opaque' });
  });

  it('maps a numeric error code to both code string and httpCode', () => {
    const raw = { error: { message: 'x', code: 429 } };
    expect(interpretChatChunk(ev(JSON.stringify(raw)))).toEqual({
      kind: 'error',
      code: '429',
      message: 'x',
      httpCode: 429,
      raw,
    });
  });

  it('keeps a symbolic error code with null httpCode', () => {
    const raw = { error: { message: 'x', code: 'rate_limited' } };
    expect(interpretChatChunk(ev(JSON.stringify(raw)))).toEqual({
      kind: 'error',
      code: 'rate_limited',
      message: 'x',
      httpCode: null,
      raw,
    });
  });

  it('falls back to error.status for httpCode and to a default message', () => {
    expect(interpretChatChunk(ev('{"error":{"status":503}}'))).toEqual({
      kind: 'error',
      code: null,
      message: 'upstream error',
      httpCode: 503,
      raw: { error: { status: 503 } },
    });
    // Код вне HTTP-диапазона — не httpCode.
    expect(interpretChatChunk(ev('{"error":{"code":1234,"message":"m"}}'))).toMatchObject({
      kind: 'error',
      code: '1234',
      httpCode: null,
    });
    expect(interpretChatChunk(ev('{"error":{"code":200}}'))).toMatchObject({ kind: 'error', httpCode: null });
    // Трёхзначная строка в диапазоне — тоже HTTP-код.
    expect(interpretChatChunk(ev('{"error":{"code":"502"}}'))).toMatchObject({
      kind: 'error',
      code: '502',
      httpCode: 502,
    });
  });

  it('treats error that is not an object as a regular chunk', () => {
    expect(interpretChatChunk(ev('{"error":"boom"}'))).toEqual({
      kind: 'chunk',
      finishReason: null,
      hasChoices: false,
    });
  });

  it('describes a regular chunk with choices and finish_reason', () => {
    const raw = {
      id: 'gen-1',
      model: 'openai/gpt-4o-mini',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
    };
    expect(interpretChatChunk(ev(JSON.stringify(raw)))).toEqual({
      kind: 'chunk',
      id: 'gen-1',
      model: 'openai/gpt-4o-mini',
      finishReason: 'stop',
      hasChoices: true,
    });
    expect(interpretChatChunk(ev('{"choices":[{"delta":{"content":"a"},"finish_reason":null}]}'))).toEqual({
      kind: 'chunk',
      finishReason: null,
      hasChoices: true,
    });
  });

  it('describes the final usage chunk with empty choices', () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 };
    expect(interpretChatChunk(ev(JSON.stringify({ id: 'gen-1', choices: [], usage })))).toEqual({
      kind: 'chunk',
      id: 'gen-1',
      finishReason: null,
      hasChoices: false,
      usage,
    });
  });

  it('ignores non-string id/model and non-object usage', () => {
    expect(interpretChatChunk(ev('{"id":5,"model":null,"usage":[1],"choices":[]}'))).toEqual({
      kind: 'chunk',
      finishReason: null,
      hasChoices: false,
    });
    expect(interpretChatChunk(ev('{"usage":null,"choices":"nope"}'))).toEqual({
      kind: 'chunk',
      finishReason: null,
      hasChoices: false,
    });
  });

  it('treats an object with error but non-empty choices as a chunk', () => {
    const raw = { error: { message: 'partial', code: 500 }, choices: [{ finish_reason: 'error' }] };
    expect(interpretChatChunk(ev(JSON.stringify(raw)))).toEqual({
      kind: 'chunk',
      finishReason: 'error',
      hasChoices: true,
    });
  });
});
