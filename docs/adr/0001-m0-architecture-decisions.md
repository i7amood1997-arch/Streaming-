# ADR 0001 — Architecture decisions from Milestone 0

- Status: **Accepted**
- Date: 2026-11-11
- Context: [ARCHITECTURE.md](../../ARCHITECTURE.md) and the
  [M0 feasibility report](../feasibility/M0-pipeline-spike.md).

## Decisions

| #   | Decision                                                                                                                                         | Notes                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | HLS with fMP4 segments is the only delivery format: on-demand transcode now, copy/remux in M2, pre-packaged ABR ladders for popular titles in M8 | Required by iPhone Safari and App Store guideline 2.5.7                  |
| 2   | 4K is served only by passthrough of a 4K source or from pre-packaged renditions, never by real-time transcoding                                  | Real-time 4K encoding per viewer is not economically viable              |
| 3   | WebTorrent 3 is the torrent engine, behind the `TorrentEngine` interface                                                                         | Can be swapped for a libtorrent sidecar without touching callers         |
| 4   | One React + TypeScript SPA, shipped as a PWA, a Capacitor iOS/iPadOS app and a Tauri macOS/Windows app                                           | Native HLS on Apple platforms, hls.js elsewhere                          |
| 5   | Backend: Fastify 5, PostgreSQL 16 with Drizzle ORM, Redis 7                                                                                      |                                                                          |
| 6   | The catalog is the authorization allowlist; users can never submit torrents, magnets or infohashes                                               | Non-negotiable                                                           |
| 7   | Self-hosted authentication: Argon2id password hashing, short-lived access tokens, rotating refresh tokens                                        | Default chosen at approval; revisit if SSO/social login becomes required |
| 8   | Metadata from Wikidata and Internet Archive only; no TMDB                                                                                        | Default chosen at approval; avoids TMDB commercial licence cost          |

## Consequences

- Milestone 1 builds the monorepo layout (`apps/`, `packages/`), the API
  skeleton with PostgreSQL/Redis and the container setup.
- The feasibility spike is promoted to `apps/media-worker`; its pure logic
  moves to `packages/media-core`.
