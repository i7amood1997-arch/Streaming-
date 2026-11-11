import { describe, expect, it } from 'vitest';
import { selectEvictions } from '../../src/torrent/cache-policy.js';
import type { CacheEntry } from '../../src/torrent/cache-policy.js';

const e = (infoHash: string, bytes: number, lastUsedMs: number, active = false): CacheEntry => ({
  infoHash,
  bytes,
  lastUsedMs,
  active,
});

describe('selectEvictions', () => {
  it('evicts nothing under quota', () => {
    expect(selectEvictions([e('a', 10, 1), e('b', 10, 2)], 20)).toEqual([]);
  });

  it('evicts least recently used first until under quota', () => {
    expect(selectEvictions([e('new', 10, 300), e('old', 10, 100), e('mid', 10, 200)], 15)).toEqual([
      'old',
      'mid',
    ]);
  });

  it('never evicts active torrents, even when that leaves the cache over quota', () => {
    expect(selectEvictions([e('busy', 100, 1, true), e('idle', 10, 2)], 50)).toEqual(['idle']);
    expect(selectEvictions([e('busy', 100, 1, true)], 0)).toEqual([]);
  });

  it('quota 0 disables caching for idle torrents', () => {
    expect(selectEvictions([e('a', 1, 1), e('b', 1, 2)], 0)).toEqual(['a', 'b']);
  });
});
