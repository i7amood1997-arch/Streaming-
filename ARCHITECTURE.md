# Architecture

> Status: **Approved 2026-11-11** ([ADR 0001](docs/adr/0001-m0-architecture-decisions.md)).
> Sections marked ✅ were validated by the M0 feasibility spike (evidence in
> [docs/feasibility/M0-pipeline-spike.md](docs/feasibility/M0-pipeline-spike.md)).
> Sections marked 🟡 are approved designs that have not been built yet.
> Decisions are listed in [§14](#14-decisions).

## 1. Goals and non-goals

**Goals.** A Netflix-class streaming product for iPhone, iPad, macOS and
Windows that:

- streams **authorized** content (public domain or appropriately licensed)
  whose distribution channel is BitTorrent;
- plays reliably in iOS Safari (the most restrictive target) and everywhere else;
- offers 720p / 1080p / 4K **only when the source genuinely provides it**;
- offers English and Arabic subtitles with correct right-to-left rendering;
- has accounts, profiles, watchlists and cross-device resume.

**Non-goals (hard constraints).** No arbitrary magnet/infohash input from end
users, no scraping of torrent indexes, no DRM circumvention, no content whose
rights are not documented in the catalog.

## 2. System overview

```
                         ┌──────────────────────────────────────────────┐
  Clients                │  One React + TypeScript SPA, three shells     │
  ───────                │  • Web/PWA (iPhone/iPad Safari, desktop)      │
                         │  • iOS/iPadOS app  (Capacitor, WKWebView)     │
                         │  • macOS/Windows   (Tauri: WKWebView/WebView2)│
                         └───────────────┬──────────────────────────────┘
                     HTTPS (JSON API)    │      HTTPS (HLS: m3u8/fMP4/WebVTT)
                 ┌───────────────────────┴──────────┐            │
                 ▼                                  │            ▼
      ┌────────────────────┐                        │   ┌──────────────────────┐
      │ API service        │  playback session      │   │ Media worker(s)      │
      │ (Fastify, stateless│ ─────────────────────► │   │ stateful, per node:  │
      │  horizontally)     │  broker: pick worker,  │   │ • TorrentEngine      │
      │ auth · profiles ·  │  sign capability URL   │   │ • Range source (lo)  │
      │ catalog · watchlist│                        │   │ • ffmpeg jobs        │
      │ progress · sync    │                        │   │ • HLS origin         │
      └──┬──────────┬──────┘                        │   └───┬──────────┬───────┘
         │          │                               │       │          │
         ▼          ▼                               │       ▼          ▼
   ┌──────────┐ ┌────────┐                          │  BitTorrent   local NVMe
   │PostgreSQL│ │ Redis  │◄─────────────────────────┘  swarm (only  (torrent cache,
   │ users,   │ │ rate   │   worker registry/heartbeat  catalog       session
   │ catalog, │ │ limits,│                              infohashes)   segments)
   │ licences,│ │ pub/sub│                                              │
   │ progress │ │ sync   │                                    🟡 packager (M8)
   └──────────┘ └────────┘                                              ▼
                                                          object storage + CDN
                                                          (pre-packaged ABR for
                                                           frequently played titles)
```

Two services with very different scaling profiles are deliberately separated:

- **API service** — stateless, cheap, scales on request rate.
- **Media worker** — stateful (torrent pieces, encoder processes, segment
  files), CPU/GPU- and disk-bound, scales on concurrent playback sessions.

## 3. Delivery strategy (the key decision)

### 3.1 Options evaluated

| Option                                                   | iPhone Safari                                                                      | Seeking                                                                                                          | Subtitles in native fullscreen                               | Server cost                          | Verdict                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ | -------------------------------------- |
| Progressive MP4 over HTTP Range                          | Only if source is already MP4 + H.264/HEVC + AAC, `moov` reachable; no MKV/AVI/DTS | Works only for downloaded/fetchable ranges; Safari issues many small range requests that stall on missing pieces | Only `<track>`; no HLS renditions                            | Lowest                               | Rejected as primary path               |
| **HLS, fMP4 segments, on-demand transcode** ✅           | Native player; universally supported                                               | Synthetic full VOD playlist → instant seek bar; encoder restarts at the target segment                           | HLS `SUBTITLES` renditions shown in the native subtitle menu | CPU per active viewer                | **Chosen for M0–M2**                   |
| HLS remux (copy) for compatible sources ✅               | Same                                                                               | Keyframe index from MP4/MKV via byte ranges; segments cut on keyframes                                           | Same                                                         | ~0 CPU (I/O only)                    | **Done (M2a)**; used for 4K            |
| Pre-packaged ABR ladder (offline transcode once, CDN) 🟡 | Same                                                                               | Perfect                                                                                                          | Same                                                         | One-off encode per title; CDN egress | Add in M8 for frequently played titles |
| MPEG-DASH                                                | Not supported by iPhone Safari                                                     | —                                                                                                                | —                                                            | —                                    | Rejected                               |

Apple's App Store Review Guideline 2.5.7 also requires HLS for video longer
than 10 minutes delivered over cellular, so HLS is mandatory for the native
iOS shell anyway.

### 3.2 Validated pipeline (M0) ✅

```
catalog entry (licence + infohash + .torrent)
      │
      ▼
TorrentEngine (WebTorrent, sequential, deselected by default, refcounted)
      │  file.createReadStream({start,end}) — prioritises pieces for the range
      ▼
TorrentSourceServer  http://127.0.0.1:<rand>/<capability>/<session>/<fileIndex>
      │  HTTP Range → ffprobe can read an MP4 `moov` at EOF, ffmpeg can seek
      ▼
ffprobe → MediaInfo → planPlayback() → PlaybackPlan (+ human-readable reasons)
      │
      ▼
synthetic VOD media playlist (all segments listed up front, 6 s grid)
      │
      ▼  first request for segment k (or a seek far beyond the encoder head)
ffmpeg job:  -ss k·6 -i <range URL> -copyts -start_at_zero
             libx264 High 8-bit, IDRs forced at the absolute 6 s grid
             AAC-LC stereo 48 kHz
             -f hls fMP4, movflags=+frag_discont, temp_file
      │  segments appear atomically; job playlist marks completion
      ▼
PlaybackSession  waits/serves seg-k.m4s, pauses encoder (SIGSTOP) when it is
                 > N segments ahead, resumes (SIGCONT), restarts on seeks
      │
      ▼
/v1/hls/<session>/<signed-token>/master.m3u8 → video/index.m3u8 → init.mp4, seg-k.m4s
                                            → subs/<lang>/index.m3u8 → subtitles.vtt
```

Why every segment is interchangeable between encoder runs (all verified):

1. `-ss` before `-i` with `-copyts -start_at_zero` keeps source timestamps, so
   a segment's `tfdt` is identical whichever job produced it.
2. `-force_key_frames` uses an **absolute time list** (`0,6,12,…`). The
   `expr:gte(t,n_forced*6)` form commonly used elsewhere is _wrong_ after a
   seek: its `t` is relative to the job's first decoded frame, which shifts
   the keyframe by up to one frame and misaligns segments between jobs (found
   and fixed during M0).
3. `-sc_threshold 0` + large GOP: no other IDRs, so with `hls_time = d/2` the
   muxer can only cut at the forced grid.
4. `-hls_segment_options movflags=+frag_discont`: init segments are
   byte-identical across jobs, so one canonical `init.mp4` serves all.

### 3.3 Adaptive bitrate (ABR)

On-demand real-time ABR would require one encoder per rung per viewer
(≈3× CPU). Proposal:

- **M0–M2:** one rendition per session, chosen from the source height, the
  client's capabilities and the viewer's quality choice. "Quality" switching
  creates a new session at the current position (≈1–2 s rebuffer).
- **M2:** for Safari-compatible sources, the copy (remux) rendition is free;
  offer _copy_ + one transcoded lower rung (e.g. 720p) so the native player
  can switch down on poor networks.
- **M8:** pre-package frequently watched titles into a full ladder
  (480p/720p/1080p H.264 + 2160p HEVC when the source is 4K) stored in object
  storage behind a CDN. Because the catalog is curated, this is the cheapest
  and best-quality path at scale; the torrent remains the acquisition channel.

### 3.4 4K

Real-time 4K software encoding is not viable per viewer (1080p `veryfast`
measured at 4.4× real time on 4 vCPU with easy synthetic content; 4K is ≈4×
the pixels). 4K is therefore offered **only** when the source is 4K and the
client can decode it, by passthrough (HEVC `hvc1` in fMP4, or H.264 level ≤5.2)
in M2, or from the pre-packaged ladder in M8. The planner already reports
`UHD_REQUIRES_PASSTHROUGH` instead of pretending.

## 4. iOS Safari constraints and how the design handles them

| Constraint                                                                                        | Consequence                                              | Handling                                                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| iPhone has no MSE before iOS 17.1 (then only `ManagedMediaSource`)                                | hls.js is not a dependable path on iPhone                | Use **native HLS** on Apple platforms; hls.js only on Chromium/Firefox/WebView2                            |
| iPhone plays in the system fullscreen player                                                      | Page CSS and custom controls are not shown in fullscreen | Subtitles delivered as HLS renditions (native menu); RTL direction encoded **in the cue text** (RLM marks) |
| Native player cannot send `Authorization` headers; relative URIs drop the query string            | Token-in-query breaks on segment requests                | **Signed token as a path segment** (`/v1/hls/<id>/<token>/…`) inherited by every relative URI ✅           |
| Codecs: H.264 (8-bit), HEVC (`hvc1` tag, fMP4 only), AAC, AC-3/E-AC-3; no MKV, AVI, VP8, DTS, ASS | Most torrent releases need remux or transcode            | Planner decides per stream; output H.264 High 8-bit + AAC-LC ✅; HEVC passthrough (M2)                     |
| Correct `CODECS`/`RESOLUTION`/`BANDWIDTH` are used for variant selection                          | Wrong values → refusal or bad switching                  | Codec string derived from profile + computed H.264 level ✅                                                |
| Autoplay requires `muted`; inline playback requires `playsinline`                                 | —                                                        | Player defaults (user gesture starts playback with sound)                                                  |
| ITP blocks third-party cookies                                                                    | Cookie auth across origins fails                         | Same-site API/media domains or bearer tokens; HLS uses capability URLs                                     |
| JS suspended in background / on lock                                                              | Progress updates lost                                    | `pagehide`/`visibilitychange` + `navigator.sendBeacon`; server tolerates gaps                              |
| HEVC `hev1` sample entry is rejected                                                              | —                                                        | Always tag passthrough HEVC as `hvc1`                                                                      |
| Subtitle segment playlists with one long segment                                                  | Accepted by Safari for VOD; also used by Jellyfin/Plex   | Single WebVTT segment per language ✅ (validate on device, M2)                                             |

**Not yet verified on real Apple hardware** (no macOS/iOS in this
environment). M0 validated against two independent HLS implementations
(hls.js and Chromium's native HLS player) plus `ffprobe` checks of every
property Safari depends on. A real-device matrix is an exit criterion of M2.

## 5. Subtitles and Arabic RTL ✅

- **Sources:** sidecar files in the torrent (`<name>.<lang>[.forced].srt|vtt`)
  ✅; embedded text streams in MKV/MP4 (M2 — requires reading the whole file,
  so they become available progressively); licensed external providers such
  as OpenSubtitles (M4, needs an API key and terms review). Bitmap subtitles
  (PGS/VobSub) need OCR or burn-in and are out of scope until requested.
- **Decoding:** BOM → strict UTF-8 → language-specific legacy code page
  (Windows-1256 for Arabic). Deterministic; no statistical sniffing.
- **Normalisation:** lenient SRT/VTT parser (CRLF, `.`/`,` decimals, missing
  counters), sanitised to WebVTT-safe markup (`<i>`, `<b>`, `<u>`), ASS
  override tags removed.
- **RTL:** each line containing Arabic/Hebrew letters is wrapped in U+200F
  RIGHT-TO-LEFT MARK on both ends, which fixes paragraph direction for lines
  that begin with digits/Latin/punctuation and keeps final punctuation on the
  correct side, _including in native fullscreen_. Punctuation stored in
  visual order by legacy editors (`؟هل…`) is repaired. Inline rendering also
  uses `::cue(:lang(ar))` with Arabic system fonts.
- **Delivery:** one HLS `SUBTITLES` rendition per language with the endonym
  as `NAME` (e.g. `العربية`) and `X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000`.

## 6. Temporary storage and cleanup ✅ (🟡 quota/LRU)

```
$MEDIA_WORK_DIR/
  torrents/<infohash>/…            torrent payload (only the pieces actually read)
  sessions/<uuid>/media/init.mp4   canonical init segment
                    media/seg-<n>.m4s
                    jobs/<job>.m3u8 + <job>-init.mp4   ffmpeg bookkeeping
                    subs/<lang>.vtt
```

- Torrents are added **deselected**: only pieces backing requested byte ranges
  are downloaded.
- Session directories are deleted on `DELETE`, on idle expiry
  (`SESSION_IDLE_TIMEOUT_SEC`), at token expiry and at startup (crash leftovers).
- Two-level idle policy: the encoder is stopped after `JOB_IDLE_TIMEOUT_SEC`
  (viewer paused), the session is kept until the longer session timeout.
- Torrents are reference-counted across sessions; at zero they linger
  (`TORRENT_LINGER_SEC`) for quick re-use and are then destroyed together with
  their data directory.
- Admission control refuses new sessions below `MIN_FREE_DISK_MIB`.
- 🟡 M2: persistent torrent cache with byte quota and LRU eviction, so popular
  titles are not re-downloaded; segment cache shared by sessions with the same
  `(content, rendition)`.

## 7. Concurrency and scaling ✅ (🟡 multi-node)

Per worker (validated):

- `MAX_SESSIONS` admission control → `503` + `Retry-After`.
- `MAX_CONCURRENT_TRANSCODES` semaphore (FIFO, with timeout).
- One encoder per session, throttled to `MAX_SEGMENTS_AHEAD` of the playhead
  (SIGSTOP/SIGCONT), so idle CPU is not burned on content nobody watches.
- One WebTorrent client per worker; torrents shared across sessions.

Capacity planning (M0 measurements, synthetic content, 4 vCPU Xeon 2.1 GHz):
720p `veryfast` 6.1× real time, 1080p 4.4× real time. Real films encode
slower than test patterns; plan **≈1 vCPU per 1080p viewer** for software
encoding, far less with copy mode or hardware encoders (NVENC/QSV/VAAPI, M8).

Multi-node (🟡 M8):

- Workers register in Redis with capacity and the infohashes they hold.
- The API's session broker chooses a worker by (1) already holding the
  torrent / segments, (2) free capacity — rendezvous hashing on infohash for
  cache locality.
- The playback URL points at that worker (`https://w3.media.example/v1/hls/…`),
  so no shared filesystem is needed.

## 8. Security

- **Authorization boundary:** only catalog entries (licence, licence URL,
  attribution, provenance, infohash, `.torrent`) can be streamed; the API has
  no magnet/infohash input. Infohash of the `.torrent` is checked against the
  catalog ✅.
- **SSRF:** peers come from untrusted sources (DHT/PEX/trackers). Private and
  reserved IPv4 ranges are blocklisted in the engine ✅; production workers
  also run with a network egress policy that denies RFC 1918, link-local,
  cloud metadata endpoints and IPv6 ULA (🟡 infra).
- **Known advisory:** WebTorrent's transitive `ip` package
  (GHSA-2p57-rm9w-gvfp, `isPublic` mis-categorisation). The engine does not
  rely on `ip.isPublic`; the blocklist and egress policy are the controls.
  Track upstream; re-evaluate in M2.
- **Playback URLs:** HMAC-SHA256 capability tokens bound to the session and
  expiry, verified in constant time ✅. Short expiry + session binding limits
  link sharing; per-user binding is added with accounts (M3).
- **Internal source server:** loopback only, random capability path ✅.
- **Process isolation:** ffmpeg is spawned with an argument array (no shell),
  inputs are internal URLs only ✅; containers run as non-root with read-only
  root FS and CPU/memory limits (🟡 M1).
- **Supply chain:** pnpm with install scripts denied by default (allow-list:
  `esbuild`, `node-datachannel`) ✅; lockfile committed; Dependabot/audit in CI (🟡).
- **Source hygiene:** no literal invisible bidi characters in source files
  ("Trojan Source"); use `\u` escapes ✅.
- 🟡 M3: Argon2id password hashing, short-lived access tokens + rotating
  refresh tokens, per-IP and per-account rate limiting, audit log.

## 9. Cross-device playback synchronisation 🟡 (M6)

- Clients send progress (`profileId`, `contentId`, `positionSec`,
  `durationSec`, `clientTime`, `deviceId`) every 10 s while playing, on pause,
  seek and `pagehide` (via `sendBeacon`).
- Server stores per-profile, per-title progress; conflict resolution is
  last-writer-wins on server receive time, ignoring regressions < 5 s from a
  different device within a short window (prevents a stale device from
  rewinding).
- Other signed-in devices receive updates over Server-Sent Events backed by
  Redis pub/sub ("Continue on this device at 42:17").
- Resuming creates a playback session with `startPositionSec`, so the first
  encoder job starts at the resume point ✅ (already supported by the spike).

## 10. Data model (initial sketch) 🟡

```
users(id, email, password_hash, created_at, …)
profiles(id, user_id, name, locale, subtitle_language, …)
devices(id, user_id, label, last_seen_at)
titles(id, slug, kind, title, original_title, year, synopsis, runtime_sec, …)
title_localizations(title_id, locale, title, synopsis)          -- ar / en
sources(id, title_id, infohash, torrent_blob, video_file_index,
        max_height, codecs, licence, licence_url, attribution,
        provenance_url, verified_by, verified_at)               -- authorization record
subtitle_assets(id, source_id, language, origin, format, forced)
watchlist(profile_id, title_id, added_at)
progress(profile_id, title_id, position_sec, duration_sec, updated_at, device_id)
playback_sessions(id, profile_id, source_id, worker_id, started_at, ended_at)  -- audit/metrics
```

## 11. Technology choices (proposed)

| Concern          | Proposal                                                            | Alternatives considered                                          |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Language         | TypeScript 6 (strict) everywhere                                    | —                                                                |
| Package/monorepo | pnpm workspaces (+ Turborepo when build graph grows)                | Nx                                                               |
| API              | Fastify 5 + Zod                                                     | NestJS (heavier), Hono                                           |
| DB / ORM         | PostgreSQL 16 + Drizzle ORM (SQL-first migrations)                  | Prisma, Kysely                                                   |
| Cache / pub-sub  | Redis 7                                                             | NATS                                                             |
| Torrent engine   | WebTorrent 3 behind `TorrentEngine` interface ✅                    | libtorrent-rasterbar sidecar (more mature, swap later if needed) |
| Media            | ffmpeg 6+/7 with libx264; hardware encoders later ✅                | GStreamer                                                        |
| Web client       | React + Vite SPA, TanStack Router/Query                             | Next.js (SSR not needed inside native shells)                    |
| Player           | native HLS on Apple, hls.js elsewhere ✅                            | Shaka (no iOS advantage), Video.js                               |
| iOS/iPadOS app   | Capacitor shell over the SPA (WKWebView → native HLS, AirPlay, PiP) | React Native / SwiftUI (duplicate UI)                            |
| macOS/Windows    | Tauri 2 (WKWebView on macOS, WebView2 on Windows)                   | Electron (larger, but bundles Chromium codecs)                   |
| Tests            | Vitest (unit/integration), Playwright (browser) ✅                  | Jest                                                             |
| Observability    | pino logs, OpenTelemetry traces, Prometheus metrics                 | —                                                                |
| Deploy           | Docker images; Compose for dev; Kubernetes or Nomad for prod        | —                                                                |

## 12. Repository layout

✅ = exists (M1). Others arrive with their milestones.

```
apps/
  api/            ✅ Fastify API: health/readiness, OpenAPI; later auth, profiles,
                     catalog, watchlist, progress, session broker
  media-worker/   ✅ torrent engine, HLS origin, ffmpeg jobs (promoted from the M0 spike)
  web/               React SPA (PWA) — shared by all shells (M5)
  ios/               Capacitor project (M7)
  desktop/           Tauri project (M7)
packages/
  contracts/      ✅ Zod schemas + types, ErrorBody/AppError, OpenAPI builder
  media-core/     ✅ pure media logic (planner, playlists, ffmpeg args, subtitles, RTL, tokens)
  player/            player engine abstraction (native HLS / hls.js) (M5)
  ui/                design system components (M5)
infra/
  docker/         ✅ multi-target Dockerfile (api, media-worker), non-root
  compose.yaml    ✅ PostgreSQL, Redis, migrate, api, media-worker
docs/
  adr/            ✅ accepted decisions
  feasibility/    ✅ spike reports
```

Lint/TypeScript/Prettier presets stay at the repository root until a second
consumer needs them packaged. Workspace packages export TypeScript sources
under the `source` condition (tsx, Vitest, `tsc` via `customConditions`) and
compiled `dist/` by default, so development needs no build step and
production runs plain `node`.

## 13. External services, credentials and infrastructure

| Item                                                                                                                 | Needed for            | Credential                                    | Status                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Authorized content sources (Internet Archive public-domain films, Blender Foundation open movies, Wikimedia Commons) | Catalog               | None; licence evidence recorded per source    | Network access to `archive.org`, `webtorrent.io` etc. is **blocked in this dev environment** |
| BitTorrent connectivity (TCP/uTP inbound + outbound, DHT UDP)                                                        | Media workers         | None                                          | Must be allowed by production firewall; not available in this sandbox                        |
| Metadata (Wikidata / Internet Archive APIs; TMDB optional)                                                           | Catalog enrichment    | TMDB API key (commercial use needs a licence) | Decision pending                                                                             |
| Subtitles provider (e.g. OpenSubtitles)                                                                              | Extra languages       | API key + terms review                        | Optional, M4                                                                                 |
| Transactional email (password reset, verification)                                                                   | Accounts              | Provider API key                              | M3                                                                                           |
| Object storage + CDN                                                                                                 | Pre-packaged ABR (M8) | Cloud credentials                             | M8                                                                                           |
| Apple Developer Program, Microsoft code signing                                                                      | Native shells         | Certificates                                  | M7                                                                                           |
| Hosting for media workers                                                                                            | Production            | Cloud account; GPU optional                   | M8                                                                                           |

All secrets come from the environment / a secret manager and are never
committed; see `.env.example`.

## 14. Decisions

All approved on 2026-11-11 and recorded in
[ADR 0001](docs/adr/0001-m0-architecture-decisions.md). New major decisions
are proposed here first and recorded as further ADRs once approved.

1. **HLS (fMP4) as the single delivery format**, with on-demand transcode now,
   copy/remux in M2 and pre-packaged ABR in M8 (§3).
2. **4K only by passthrough or pre-packaging**, never real-time 4K transcode (§3.4).
3. **WebTorrent** as the engine behind a swappable interface (§11).
4. **One SPA + Capacitor + Tauri** for all four platforms (§11).
5. **Fastify + PostgreSQL/Drizzle + Redis** for the backend (§11).
6. **Catalog-as-allowlist**: no user-supplied torrents, ever (§8).
7. **Auth approach**: self-hosted (Argon2id + rotating refresh tokens), no
   managed identity provider (M3). Revisit if SSO/social login is required.
8. **Metadata source**: Wikidata and Internet Archive only; TMDB is not used
   (commercial licence cost). Revisit if metadata coverage proves insufficient.

## 15. Risk register

| Risk                                                                      | Impact | Likelihood                   | Mitigation                                                                                                                                            |
| ------------------------------------------------------------------------- | ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Safari/iOS behaves differently from hls.js/Chromium on our playlists | High   | Medium                       | Device test matrix is an M2 exit criterion; follow Apple HLS authoring spec; Apple `mediastreamvalidator` on macOS CI runner                          |
| Torrent swarm too slow/unhealthy for real-time playback                   | High   | Medium for obscure PD titles | Prefer torrents with HTTP web seeds (Internet Archive provides them); pre-fetch on catalog ingest; persistent cache; pre-packaging for popular titles |
| CPU cost of per-viewer transcoding                                        | High   | High at scale                | Copy mode (M2), hardware encoders, pre-packaged ABR (M8), admission control ✅                                                                        |
| Seeking into not-yet-downloaded regions stalls                            | Medium | High                         | Range-driven piece prioritisation ✅; long read timeout; UI shows buffering; seek restarts only the needed range                                      |
| Copy mode needs exact keyframe index                                      | Medium | —                            | ✅ MP4/MKV index matched against ffprobe; unsupported files fall back to transcode; `driftEvents` metric                                              |
| Open-GOP HEVC (CRA) leading pictures across copy boundaries               | Medium | Medium                       | Fine for continuous playback; verify Safari seek behaviour on device (M2 exit)                                                                        |
| App Store review of a torrent-backed product                              | High   | Medium                       | Client contains no torrent code (server-side only); only licensed catalog; document licences in-app                                                   |
| Legal: mis-labelled "public domain" content                               | High   | Low–Medium                   | Per-source licence evidence + human verification step in ingest (M4)                                                                                  |
| WebTorrent dependency advisories / maintenance                            | Medium | Medium                       | Engine interface allows swapping to libtorrent; network-level egress controls                                                                         |
| HDR sources look washed out after SDR transcode                           | Medium | Medium                       | Tone mapping (zscale/tonemap) in M2; HDR passthrough for capable clients                                                                              |
