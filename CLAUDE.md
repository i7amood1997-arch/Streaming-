# CLAUDE.md — permanent engineering instructions

You are the principal engineer for a production streaming platform (iPhone,
iPad, macOS, Windows). Build production-quality software, not prototypes.

## Non-negotiable rules

1. **Authorized content only.** Everything streamed must come from the catalog
   (licence, licence URL, attribution, provenance, infohash). Never add
   features that take arbitrary magnets/infohashes from users, scrape torrent
   indexes or sites, or circumvent DRM. If a request needs any of these,
   refuse that part and explain.
2. **No fake functionality.** Do not present placeholders, mocks or stubs as
   working features. Unimplemented behaviour has to fail explicitly and be
   documented as planned.
3. **TypeScript strict** (`tsconfig.base.json`: `strict`,
   `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …). Do not use
   `any`, and do not use `!` outside tests. Validate external input with Zod.
4. **Secrets** come only from the environment or a secret manager. Never
   commit them, log them, or put them in URLs other than signed capability
   tokens. Document every variable in `.env.example`.
5. **Never claim done without evidence.** Run the checks below and report the
   real results, failures included.
6. **Major architectural changes need approval.** Propose them in
   ARCHITECTURE.md (§14) first, and work in milestones (DEVELOPMENT_PLAN.md).

## Quality gates (run before every commit)

```bash
pnpm install --frozen-lockfile   # catches lockfile drift exactly like CI
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test
pnpm test:integration   # API changes; needs TEST_DATABASE_URL / TEST_REDIS_URL
pnpm test:e2e           # whenever media, torrent, session or HTTP code changes
```

Never pipe gate commands into `head`/`tail`/`grep` when judging success: the
pipeline's exit code is the last command's, which hides failures. Check each
command's own exit status.

UI milestones also need responsive checks at iPhone, iPad and desktop widths,
in both LTR and RTL.

## Documentation to keep current

These docs must match the code. Update them in the same change:

- `README.md`: setup and run instructions.
- `ARCHITECTURE.md`: architecture, decisions, risks.
- `DEVELOPMENT_PLAN.md`: milestone status.
- `API_DOCUMENTATION.md`: every endpoint, marked as implemented or planned.
- `.env.example`: every environment variable.
- `docs/feasibility/*`: evidence from spikes.

## Media pipeline invariants (do not break without re-running e2e)

- HLS fMP4 only. Segments sit on a fixed grid (`HLS_SEGMENT_DURATION_SEC`)
  that the synthetic VOD playlist describes.
- ffmpeg jobs use `-ss` before `-i` with `-copyts -start_at_zero`.
  `-force_key_frames` takes an **absolute time list**, never `expr:` (it
  drifts after seeks). `-sc_threshold 0`, `hls_time = d/2`, and
  `-hls_segment_options movflags=+frag_discont` (identical init segments).
- H.264 output: High profile, 8-bit `yuv420p`, level from `h264LevelFor()`.
  Audio output: AAC-LC stereo 48 kHz. The codec strings in the master
  playlist must match the output.
- Stream tokens go in the URL **path**, never the query string, because the
  iOS native player drops the query on relative URIs.
- Subtitles are UTF-8 WebVTT with `X-TIMESTAMP-MAP`. RTL lines are wrapped in
  U+200F.
- Torrents are added deselected, refcounted, released on session end, and
  deleted after the linger time.
- Copy mode: boundaries come from the container index (never decoded-frame
  times), require ≥ 0.3 s to the next keyframe, and each segment is one ffmpeg
  `-c copy` run seeking to `boundary + 0.2 s` **without** `-start_at_zero`,
  cut by the HLS muxer (`hls_time` just under the segment length), never by
  `-to`. HEVC is written as `hvc1`. `driftEvents` must stay 0 in tests.
- Separate audio rendition (copied video, non-AAC source audio): AAC-LC stereo,
  `hls_time = d`, raw container time (no `-start_at_zero`). A track's last
  listed segment is served only after its producer exits, with any overflow
  segments appended.

## Code conventions

- ESM, Node ≥ 22, pnpm workspaces. Use `apps/*` for deployables, `packages/*`
  for shared libraries, and `spikes/*` for disposable experiments.
- Keep pure logic (planning, playlists, parsing) separate from I/O so it can
  be unit-tested.
- Domain errors are `AppError` subclasses, mapped to HTTP in one place.
- Spawn child processes with argument arrays, never through a shell.
- Never put literal invisible Unicode (bidi controls, BOM, zero-width
  characters) in source files. Use `\u` escapes ("Trojan Source").
- pnpm install scripts are denied by default. Any addition to
  `onlyBuiltDependencies` must be justified in `pnpm-workspace.yaml`.
- Commit messages are imperative, explain _why_, and stay scoped to one concern.

## Platform facts to remember

- iPhone Safari uses the native HLS player in system fullscreen. Page CSS and
  custom controls do not apply there, and MSE is unavailable before
  iOS 17.1 (`ManagedMediaSource` only after that). Use native HLS on Apple
  platforms and hls.js elsewhere.
- HEVC must use the `hvc1` sample entry in fMP4. Safari plays no MKV, AVI,
  DTS or ASS.
- Real-time 4K transcoding is not viable. 4K is offered only by passthrough
  or pre-packaging.
