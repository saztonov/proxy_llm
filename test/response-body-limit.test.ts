import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { readBodyWithLimit, UpstreamResponseTooLargeError, safeParseJson } from '../src/upstream/read-body-with-limit.js';

describe('readBodyWithLimit', () => {
  it('reads small body fully', async () => {
    const text = await readBodyWithLimit(Readable.from(['hello ', 'world']), 1000);
    expect(text).toBe('hello world');
  });

  it('throws UpstreamResponseTooLargeError when exceeding limit', async () => {
    const big = Buffer.alloc(2000, 'a');
    await expect(readBodyWithLimit(Readable.from([big]), 1000)).rejects.toBeInstanceOf(
      UpstreamResponseTooLargeError,
    );
  });

  it('throws as soon as accumulated chunks exceed limit', async () => {
    const chunks = [Buffer.alloc(400, 'a'), Buffer.alloc(400, 'b'), Buffer.alloc(400, 'c')];
    await expect(readBodyWithLimit(Readable.from(chunks), 1000)).rejects.toBeInstanceOf(
      UpstreamResponseTooLargeError,
    );
  });

  it('safeParseJson returns null on invalid', () => {
    expect(safeParseJson('not json')).toBeNull();
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
  });
});
