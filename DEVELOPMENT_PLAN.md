# Development plan

Status legend: ✅ done · 🔄 in progress · ⏳ not started · ⛔ blocked

Every milestone ends with: TypeScript check, lint, format check, unit tests,
relevant integration/e2e tests, responsive-layout check (UI milestones),
documentation update. A milestone is only marked done when its exit criteria
are demonstrated, not when code exists.

## M0 — Architecture & feasibility ✅ (awaiting approval)

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

**Exit:** architecture decisions in ARCHITECTURE.md §14 approved.

## M1 — Foundations ⏳

- Restructure into `apps/` + `packages/` (ARCHITECTURE.md §12); extract pure
  media logic from the spike into `packages/media-core` with its tests.
- `packages/contracts` (Zod schemas shared by API, worker, clients).
- `apps/api` skeleton: Fastify, config validation, structured logging, error
  model, health/readiness, OpenAPI generation.
- PostgreSQL + Drizzle migrations; Redis client; `infra/compose.yaml`.
- Dockerfiles (non-root, pinned ffmpeg) for api and media-worker.
- CI: typecheck, lint, format, unit, e2e (ffmpeg + Chromium), dependency audit.

**Exit:** `docker compose up` gives a healthy api + worker + db + redis; CI green.

## M2 — Media worker v1 ⏳

- Promote the spike to `apps/media-worker`; worker ↔ API session broker contract.
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
