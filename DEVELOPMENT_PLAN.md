# Development plan

Status legend: ✅ done · 🔄 in progress · ⏳ not started · ⛔ blocked

Every milestone ends with: TypeScript check, lint, format check, unit tests,
relevant integration/e2e tests, responsive-layout check (UI milestones),
documentation update. A milestone is only marked done when its exit criteria
are demonstrated, not when code exists.

## M0 — Architecture & feasibility ✅

- ✅ Environment inspection, toolchain (pnpm workspace, TS 6 strict, ESLint
  strict-type-checked, Prettier, Vitest, Playwright).
- ✅ Architecture proposal: [ARCHITECTURE.md](ARCHITECTURE.md).
- ✅ Feasibility spike `spikes/m0-pipeline`: authorized catalog → WebTorrent →
  range source → ffprobe → planner → on-demand fMP4 HLS → WebVTT (en/ar, RTL)
  → browser playback; throttling, seek restarts, admission control, cleanup.
- ✅ Evidence: [docs/feasibility/M0-pipeline-spike.md](docs/feasibility/M0-pipeline-spike.md)
  (50 unit + 11 e2e tests).
- ⛔ Real public-domain film and real Safari/iOS validation — blocked by this
  environment (no network access to content hosts, no Apple hardware). Moved
  to M2 exit criteria with a runbook.

**Exit:** ✅ architecture decisions approved 2026-11-11 ([ADR 0001](docs/adr/0001-m0-architecture-decisions.md)).

## M1 — Foundations ✅

- ✅ Restructure into `apps/` + `packages/`. The spike became
  `apps/media-worker`; pure media logic moved to `packages/media-core`.
- ✅ `packages/contracts`: Zod schemas (playback, catalog, health), shared
  `ErrorBody`/`AppError`, OpenAPI 3.1 builder. The worker uses them.
- ✅ `apps/api`: Fastify, validated config, pino logging, error model,
  `/healthz`, `/readyz` (PostgreSQL + Redis, per-dependency timeouts),
  `/openapi.json`, CORS allow-list.
- ✅ PostgreSQL + Drizzle: schema and first migration (`titles`,
  `title_localizations`, `sources`) with integrity constraints.
- ✅ Redis client with background reconnects, fail-fast while down.
- ✅ Multi-target Dockerfile (non-root; worker on Ubuntu 24.04 for ffmpeg
  6.1, the validated version) and `infra/compose.yaml`.
- ✅ CI: frozen install, typecheck, lint, format, build, unit, integration
  (Postgres/Redis services), e2e, image builds, audit.

**Evidence:** 63 unit tests, 4 integration tests (real PostgreSQL 16 and
Redis 7), 11 e2e tests. `docker compose up` → all five services healthy,
migrations applied, `/readyz` ready. Playback through the containerised
worker verified: segment alignment after a seek-restart, Arabic RTL cues.
Redis outage → `/readyz` 503, back to ready within ~1 s after recovery.

**Exit:** ✅ compose stack healthy. CI on GitHub: see the run for the M1 commits.

## M2 — Media worker v1 ⏳

- Worker ↔ API session broker contract (API creates sessions, picks a worker).
- **Copy (remux) mode:** keyframe index from MP4 `stss` / MKV `Cues`;
  synthetic playlist from real keyframe times; HEVC passthrough (`hvc1`).
- 4K passthrough when source and client allow it.
- Audio: stream selection by language; AAC passthrough; AC-3/E-AC-3
  passthrough rendition for Apple devices.
- Embedded text subtitles (progressive extraction); HDR → SDR tone mapping.
- Persistent torrent cache with byte quota + LRU; shared segment cache per
  `(content, rendition)`.
- Metrics (sessions, encoder speed, rebuffer-inducing waits, swarm health).
- **Real-world validation** with Sintel / Big Buck Bunny / Tears of Steel /
  Internet Archive titles; **iOS/iPadOS/macOS Safari device matrix** and
  `mediastreamvalidator` clean.

**Exit:** device matrix passes for 1080p transcode, copy mode and 4K passthrough.

## M3 — Accounts & security ⏳

- Registration, login, email verification, password reset (provider needed).
- Argon2id, access + rotating refresh tokens, device list, sign-out-everywhere.
- Profiles (incl. locale and default subtitle language).
- Rate limiting, audit log, playback tokens bound to user/profile.

## M4 — Catalog & ingest ⏳

- Admin ingest of authorized sources with licence evidence and a human
  verification step; infohash/torrent validation; probe on ingest.
- Metadata enrichment (Wikidata / Internet Archive; TMDB if approved),
  localisation (ar/en), artwork pipeline.
- Search and browse endpoints; external subtitle provider (optional).

## M5 — Web client (PWA) ⏳

- Design system, responsive layouts (iPhone, iPad, desktop), Arabic RTL UI
  (`dir="rtl"`, logical CSS properties), accessibility.
- Home rows, title details, search, player screen (custom inline controls,
  native fullscreen on iPhone), subtitle and quality menus, error/loading states.

## M6 — Watchlist, progress & cross-device sync ⏳

- Watchlist CRUD, continue-watching row, progress API with conflict rules,
  SSE live updates, resume-on-another-device flow.

## M7 — Native shells ⏳

- Capacitor iOS/iPadOS app (AirPlay, PiP, Now Playing, background audio).
- Tauri macOS/Windows apps (codec checks in WebView2, auto-update, signing).
- App Store / Microsoft Store submission readiness review.

## M8 — Production readiness ⏳

- Multi-worker routing (Redis registry, infohash affinity), autoscaling.
- Pre-packaged ABR ladder in object storage + CDN for frequently played titles.
- Hardware encoding, load tests, chaos tests, security review, backups,
  infrastructure as code, runbooks, SLOs.
