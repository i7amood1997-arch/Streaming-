import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../src/session/semaphore.js';
import { limitStream } from '../../src/torrent/engine.js';
import { parseRange } from '../../src/torrent/source-server.js';

describe('parseRange', () => {
  it('parses single byte ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-0', 100)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
  });

  it('rejects unsatisfiable or multi ranges', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-1', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});

describe('limitStream', () => {
  it('truncates to the requested length', async () => {
    const source = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const chunks: Buffer[] = [];
    for await (const c of limitStream(source, 7)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello w');
  });
});

describe('Semaphore', () => {
  it('queues FIFO and times out', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire(100);
    const order: string[] = [];
    const second = sem.acquire(1000).then((r) => {
      order.push('second');
      return r;
    });
    await expect(sem.acquire(10)).rejects.toThrow(/Timed out/);
    release();
    (await second)();
    expect(order).toEqual(['second']);
    expect(sem.available).toBe(1);
  });
});
