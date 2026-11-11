# Streaming platform

A premium movie and TV streaming product for iPhone, iPad, macOS and Windows.
It streams **authorized** content only (public domain or appropriately
licensed). The server gets that content over BitTorrent and delivers it to
clients as HLS with English and Arabic subtitles.

**Project status: Milestone 1 (foundations) is done.** The architecture is
approved ([ADR 0001](docs/adr/0001-m0-architecture-decisions.md)). There is
an API service, a media worker and shared packages, but no product UI yet.
Read in this order:

1. [ARCHITECTURE.md](ARCHITECTURE.md): system design, decisions, risks.
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
| PostgreSQL 16, Redis 7  | —                            | Via Docker Compose (below), or local installs                                                 |
| Docker + Compose v2     | —                            | For the container stack                                                                       |

## Install

```bash
pnpm install
cp .env.example .env   # optional; defaults work for local development
```

pnpm blocks dependency install scripts by default. The only ones allowed
(`pnpm-workspace.yaml`) are `esbuild` and `node-datachannel`, which downloads
a prebuilt native binary.

## Run everything with Docker Compose

```bash
pnpm --filter @streaming/media-worker fixtures   # once: CC0 test title + catalog.json
pnpm --filter @streaming/media-worker seed       # terminal 1: BitTorrent peer on :51413
docker compose -f infra/compose.yaml up --build  # terminal 2
```

| Service      | URL                                                       | Notes                                      |
| ------------ | --------------------------------------------------------- | ------------------------------------------ |
| API          | <http://127.0.0.1:3000/readyz>                            | `/healthz`, `/readyz`, `/openapi.json`     |
| Media worker | <http://127.0.0.1:8080/player/>                           | Diagnostic player; press **Start session** |
| PostgreSQL   | `postgres://streaming:streaming@127.0.0.1:5432/streaming` | Migrations run by the `migrate` service    |
| Redis        | `redis://127.0.0.1:6379`                                  |                                            |

Behind a TLS-intercepting proxy, pass its CA to the image build:
`docker build --secret id=extra_ca,src=/path/ca.pem -f infra/docker/Dockerfile --target api .`

## Run services without Docker

```bash
# API (needs PostgreSQL and Redis; see .env.example)
cd apps/api
pnpm db:migrate
pnpm dev

# Media worker: two terminals in apps/media-worker
pnpm seed                    # generates the CC0 test title once, then seeds it
TORRENT_BOOTSTRAP_PEERS=127.0.0.1:51413 TORRENT_ALLOW_PRIVATE_PEERS=true \
TORRENT_DHT=false TORRENT_TRACKERS=false pnpm dev
```

Open <http://127.0.0.1:8080/player/>. You can also open it from an iPhone or
iPad on the same network: start the worker with `HOST=0.0.0.0` and browse to
`http://<your-ip>:8080/player/`. Safari uses its native HLS player there.

To test with real public-domain or Creative Commons films, follow the runbook
in the feasibility report (§6).

## Quality checks

From the repository root:

```bash
pnpm typecheck      # tsc --noEmit, strict
pnpm lint           # ESLint (typescript-eslint strict-type-checked)
pnpm format:check   # Prettier
pnpm build          # compile every package to dist/
pnpm test           # unit tests
pnpm test:integration  # API against real PostgreSQL + Redis (TEST_DATABASE_URL, TEST_REDIS_URL)
pnpm test:e2e       # local swarm → HLS → Chromium (needs ffmpeg + Chromium)
pnpm check          # typecheck + lint + format + unit
```

## Repository layout

```
apps/api/               Fastify API: health/readiness, OpenAPI; later auth, catalog, watchlist, sync
  src/db/               Drizzle schema, client, migrator   drizzle/  generated SQL migrations
apps/media-worker/      torrent engine, HLS origin, ffmpeg jobs (promoted from the M0 spike)
  src/torrent/          TorrentEngine (WebTorrent) + loopback range source server
  src/session/          playback sessions, transcode jobs, admission control
  src/http/             Fastify routes (session API, HLS, diagnostic player)
  src/fixtures/         CC0 test title generator + local seeder
packages/contracts/     Zod wire contracts, error model, OpenAPI builder
packages/media-core/    pure media logic: planner, playlists, ffmpeg arguments,
                        ffprobe parsing, subtitles/RTL, stream tokens
infra/docker/           multi-target Dockerfile (api, media-worker)
infra/compose.yaml      local stack
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
