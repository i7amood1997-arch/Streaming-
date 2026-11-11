/** One torrent's data directory in the cache. */
export interface CacheEntry {
  infoHash: string;
  /** Bytes actually allocated on disk (sparse files count only written blocks). */
  bytes: number;
  /** Last time a session acquired or released it (ms since epoch). */
  lastUsedMs: number;
  /** Held by a session or still lingering in the client: never evictable. */
  active: boolean;
}

/**
 * Least-recently-used eviction under a byte quota. Active torrents are never
 * evicted, even if that leaves the cache above quota (they are needed now);
 * the free-disk admission check protects the volume in that case.
 */
export function selectEvictions(entries: readonly CacheEntry[], quotaBytes: number): string[] {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const evictions: string[] = [];
  const candidates = entries
    .filter((e) => !e.active)
    .sort((a, b) => a.lastUsedMs - b.lastUsedMs || a.infoHash.localeCompare(b.infoHash));
  for (const entry of candidates) {
    if (total <= quotaBytes) break;
    evictions.push(entry.infoHash);
    total -= entry.bytes;
  }
  return evictions;
}
