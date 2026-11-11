# M2c — Persistent torrent cache and bounded piece selection

Date: 2026-11-11 · Code: `apps/media-worker/src/torrent/{engine,cache-policy}.ts`.

## 1. Cache

- A released torrent lingers in the client for `TORRENT_LINGER_SEC`, then
  leaves it **with its data kept on disk** (previously the data was deleted).
- Re-adding a cached torrent hash-verifies the pieces on disk (WebTorrent's
  default), so cached data is checked, not trusted, and playback of the
  cached ranges needs no peer.
- `TORRENT_CACHE_MAX_MIB` (default 20 GiB) caps the cache. Above it, idle
  torrents are evicted least-recently-used first (`selectEvictions`). Recency is
  a `.last-used` marker per torrent directory, so the order survives restarts.
  Torrents in use or lingering are never evicted; the free-disk admission check
  protects the volume if active data alone exceeds the quota. `0` disables the cache.
- Quota is enforced at startup and after every release. Passes are serialised,
  and acquires wait for a running pass, so an eviction never races a re-add.

## 2. Finding: every stream open downloaded the rest of the title

WebTorrent's `FileIterator` selects **every piece of the requested range** when
a stream opens, and ffmpeg opens ranges to end-of-file (`bytes=X-`). So each
probe, each seek and each per-segment copy job prioritised the whole remainder
of the file, and a paused encoder's open connection kept it selected. That
wastes swarm bandwidth and competes with the bytes actually needed.

Fix: `windowedStream` reads long ranges as consecutive windows
(`TORRENT_READ_WINDOW_MIB`, default 8 MiB): only the window being read plus one
primed window are selected; abandoning the stream deselects both.

| Measurement (CC0 1080p title, 29.6 MB; play 2 segments, read-ahead 2) | Cached on disk |
| --------------------------------------------------------------------- | -------------- |
| Unbounded reads (before)                                              | 29.6 MB (all)  |
| 8 MiB windows (default)                                               | 25.3 MB        |
| 1 MiB windows                                                         | 8.0 MB         |

With a 29.6 MB test file, two primed 8 MiB windows are already half the file;
on multi-GB films the default window bounds over-fetch to ~16 MB per open
instead of the entire remainder.

## 3. Evidence (`apps/media-worker/test/e2e/cache.e2e.test.ts`, `test/unit/cache-policy.test.ts`)

| Check                                                                                                                              | Result |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Released torrent keeps its data and recency marker; footprint < 12 MiB (measured 8.0 MB)                                           | ✅     |
| The only seeder is stopped and the worker restarted: a new session probes, indexes and serves segments 0–1 from cache with 0 peers | ✅     |
| Worker started with quota 0 evicts the idle cached torrent at startup                                                              | ✅     |
| LRU order, active torrents never evicted, quota 0 semantics (unit)                                                                 | ✅     |

## 4. Not covered yet

- Shared segment cache per `(content, rendition)` across sessions (segments are
  still produced per session).
- Disk-pressure eviction of _active_ data and cache metrics export (M8 observability).
