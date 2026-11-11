# Streaming platform

A premium movie and TV streaming product for iPhone, iPad, macOS and Windows.
It streams **authorized** content only (public domain or appropriately
licensed). The server gets that content over BitTorrent and delivers it to
clients as HLS with English and Arabic subtitles.

**Project status: Milestone 0 (architecture & feasibility) is done and the
architecture is awaiting approval.** There is no product UI yet. Read in this order:

1. [ARCHITECTURE.md](ARCHITECTURE.md): system design, decisions to approve, risks.
2. [docs/feasibility/M0-pipeline-spike.md](docs/feasibility/M0-pipeline-spike.md): what was proven, and what was not.
3. [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md): milestones and progress.
4. [API_DOCUMENTATION.md](API_DOCUMENTATION.md): endpoints.

## Prerequisites

| Tool                    | Version                      | Notes                                                                                         |
| ----------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| Node.js                 | ≥ 22.12                      | `.nvmrc` pins 22                                                                              |
| pnpm                    | 10.x                         | `corepack enable`                                                                             |
| ffmpeg + ffprobe        | ≥ 6.0 with `libx264`         | `apt install ffmpeg` / `brew install ffmpeg`                                                  |
| Chromium for Playwright | matching `playwright@1.63.0` | `pnpm --filter @streaming/media-worker exec playwright install chromium` (only for e2e tests) |

## Install

```bash
pnpm install
cp .env.example .env   # optional; defaults work for local development
```

pnpm blocks dependency install scripts by default. The only ones allowed
(`pnpm-workspace.yaml`) are `esbuild` and `node-datachannel`, which downloads
a prebuilt native binary.

## Run the M0 pipeline locally

It needs two terminals. Both commands run from `apps/media-worker`.

```bash
# 1. Generate the CC0 test title (≈20 s, once) and seed it as a BitTorrent peer
pnpm seed

# 2. Start the media server, telling it where the local peer is
TORRENT_BOOTSTRAP_PEERS=127.0.0.1:51413 TORRENT_ALLOW_PRIVATE_PEERS=true \
TORRENT_DHT=false TORRENT_TRACKERS=false pnpm dev
```

Open <http://127.0.0.1:8080/player/> and press **Start session**. You can
also open it from an iPhone or iPad on the same network: start the server
with `HOST=0.0.0.0` and browse to `http://<your-ip>:8080/player/`. Safari
uses its native HLS player there.

To test with real public-domain or Creative Commons films, follow the runbook
in the feasibility report (§6).

## Quality checks

From the repository root:

```bash
pnpm typecheck      # tsc --noEmit, strict
pnpm lint           # ESLint (typescript-eslint strict-type-checked)
pnpm format:check   # Prettier
pnpm test           # unit tests
pnpm test:e2e       # local swarm → HLS → Chromium (needs ffmpeg + Chromium)
pnpm check          # typecheck + lint + format + unit
```

## Repository layout

```
apps/media-worker/      torrent engine, HLS origin, ffmpeg jobs (promoted from the M0 spike)
  src/torrent/          TorrentEngine (WebTorrent) + loopback range source server
  src/media/probe.ts    runs ffprobe (parsing lives in media-core)
  src/session/          playback sessions, transcode jobs, admission control
  src/http/             Fastify routes (session API, HLS, diagnostic player)
  src/fixtures/         CC0 test title generator + local seeder
packages/media-core/    pure media logic: planner, playlists, ffmpeg arguments,
                        ffprobe parsing, subtitles/RTL, stream tokens
docs/adr/               accepted architecture decisions
docs/feasibility/       spike reports
```

Workspace packages export their TypeScript sources under the `source`
condition (used by `tsx`, Vitest and `tsc`) and compiled `dist/` files by
default (used in production with plain `node`).

The target layout is in ARCHITECTURE.md §12.

## Content policy

Only titles in the catalog can be streamed. Each catalog entry records its
licence, licence URL, attribution, provenance and infohash. The software has
no feature for streaming an arbitrary magnet link or infohash, and it must
never get one.
