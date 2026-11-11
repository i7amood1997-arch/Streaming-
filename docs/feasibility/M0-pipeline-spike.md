# M0 feasibility spike — authorized torrent → HLS → iOS-compatible playback

Date: 2026-11-11 · Code: [`spikes/m0-pipeline`](../../spikes/m0-pipeline) ·
Status: **complete for what this environment can verify** (see §5 for what is not verified).

## 1. Question

Can a backend acquire an authorized title over BitTorrent and deliver it, while
it is still downloading, as a stream that iPhone Safari's native player
accepts, with seeking, English + Arabic subtitles, bounded storage and
multiple concurrent sessions?

## 2. Environment

- Linux container, 4 vCPU (Intel Xeon @ 2.1 GHz), 15 GiB RAM.
- Node 22.23, pnpm 10.28, ffmpeg/ffprobe 6.1.1 (libx264), WebTorrent 3.0.21,
  Playwright 1.63 with Chromium (HeadlessChrome 153).
- **Network:** outbound access is limited to package registries.
  `archive.org`, `webtorrent.io` and CDNs return `403` at the proxy, and
  BitTorrent peer traffic is not routed. No macOS/iOS devices are available.

Consequently the test title could not be a downloaded public-domain film.
Instead the spike **generates** its test title (ffmpeg test pattern + tone,
subtitles written for the project) and dedicates it to the public domain
(CC0). It is seeded by a real, separate BitTorrent peer on loopback, so the
full peer-wire path is exercised. §6 is the runbook to repeat the validation
with real public-domain / CC-licensed films once network access is available.

## 3. Test title

| Property  | Value                                                                                                                                           | Why                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Video     | 1920×1080, 23.976 fps, H.264 High, 4 s GOP, 90 s                                                                                                | Typical web release; 23.976 fps exercises non-integer frame timing   |
| Audio     | AAC-LC stereo 48 kHz                                                                                                                            | —                                                                    |
| Container | MP4 **without** faststart (`moov` at end of file)                                                                                               | Forces the pipeline to fetch the tail of the torrent before playback |
| Subtitles | `*.en.srt` UTF-8 (with `<i>`, `<font>`, `&`); `*.ar.srt` **Windows-1256**, CRLF, multi-line dialogue, one line with punctuation in visual order | Real-world Arabic subtitle pathologies                               |
| Licence   | CC0 1.0                                                                                                                                         | Unambiguously authorized                                             |
| Torrent   | Multi-file (video, 2 subtitles, LICENSE.txt), infohash recorded in `catalog.json`                                                               | Catalog-as-allowlist                                                 |

## 4. What was validated (automated, `pnpm test:e2e`, 11 tests, ~28 s)

| #   | Check                                                                                                                                                                                                                                                       | Result                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Content not in the catalog is refused (`404`)                                                                                                                                                                                                               | ✅                                                        |
| 2   | Session creation pulls metadata, `moov` (at EOF) and subtitles **from a BitTorrent peer**, downloading only the needed pieces (`progress < 1`)                                                                                                              | ✅                                                        |
| 3   | Master playlist: `CODECS="avc1.64001f,mp4a.40.2"`, `RESOLUTION`, `FRAME-RATE`, `CLOSED-CAPTIONS=NONE`, Arabic subtitle rendition with `NAME="العربية"`; media playlist is a complete VOD playlist (15 × 6 s, `ENDLIST`) available before any segment exists | ✅                                                        |
| 4   | Forged token → `403`; token carried in the path so relative URIs keep working                                                                                                                                                                               | ✅                                                        |
| 5   | Segments: H.264 High, level 3.1, `yuv420p`, 1280×720; AAC-LC 2 ch 48 kHz; each segment starts with its only IDR; segment _k_ starts at _k_·6 s                                                                                                              | ✅                                                        |
| 6   | Encoder throttling: pauses (SIGSTOP) when > 4 segments ahead of the viewer                                                                                                                                                                                  | ✅                                                        |
| 7   | Seek far ahead → encoder restart; segment 13 from the new job decodes with the **first job's** init segment, starts at 78.0 s and ends exactly where a continuous encode would (segment 14 starts at the first frame ≥ 84 s)                                | ✅                                                        |
| 8   | Arabic WebVTT: Windows-1256 → UTF-8, RLM-wrapped lines, visual-order punctuation repaired, `X-TIMESTAMP-MAP` present; English markup sanitised                                                                                                              | ✅                                                        |
| 9   | **Chromium + hls.js**: plays, exposes `en` + `ar` text tracks, renders the active Arabic cue (starts with U+200F), seeks to 70 s beyond the encoded range and resumes playing, no player errors                                                             | ✅                                                        |
| 10  | Admission control: third concurrent session → `503` + `Retry-After: 10`                                                                                                                                                                                     | ✅                                                        |
| 11  | Cleanup: `DELETE` removes the session directory and returns `404` afterwards; idle reaper removes the remaining session; torrent released and its data directory deleted                                                                                    | ✅                                                        |
| 12  | **Chromium native HLS player** (second independent implementation): plays and seeks to 70 s                                                                                                                                                                 | ✅ (exposes no HLS subtitle tracks — Chromium limitation) |

Plus 50 unit tests (config, planner, codec strings/levels, playlists, subtitles,
RTL, charset decoding, tokens, range parsing, semaphore, ffmpeg arguments).

Manual run (`pnpm seed` + `pnpm start` + curl) at 1080p: first segment served
**1.8 s** after the first request (torrent fetch + 6 s of 1080p encode).

Throughput on this machine (full 90 s title, `veryfast`, synthetic content —
real films are harder to encode):

| Output | Wall time | Real-time factor |
| ------ | --------- | ---------------- |
| 720p   | 14.7 s    | 6.1×             |
| 1080p  | 20.4 s    | 4.4×             |

## 5. Not validated here (must be done before M2 is called complete)

- **Real Safari on iPhone/iPad/macOS.** No Apple hardware. Every property
  Safari relies on was checked indirectly (codec strings, profile/level, pixel
  format, fMP4 structure, playlist tags, subtitle renditions, path tokens), and
  two independent HLS implementations played the stream, but Safari itself has
  not. Apple's `mediastreamvalidator` (macOS only) has not been run.
- Public internet swarms, trackers, DHT, web seeds and slow/unhealthy swarms.
- Real films (complex content, long durations, MKV, HEVC, 10-bit, HDR,
  5.1/DTS audio, embedded subtitles, anamorphic video).
- 4K (by design: passthrough is M2).
- Load beyond 2 concurrent sessions; long-running memory behaviour.

## 6. Runbook: repeating M0 with real authorized titles

Requires outbound HTTPS to the hosts below (and, for true swarm testing,
BitTorrent TCP/UDP), e.g. on a developer machine or a cloud environment with
those hosts allowed.

1. Pick titles whose licence is documented:
   - _Sintel_ (Blender Foundation, CC BY 3.0) — torrent with HTTP web seed at
     `https://webtorrent.io/torrents/sintel.torrent`; ships 9 subtitle languages.
   - _Big Buck Bunny_ / _Tears of Steel_ (Blender Foundation, CC BY) — include
     4K masters for the M2 passthrough test.
   - Internet Archive _Feature Films_ collection items marked public domain —
     each item exposes `<item>_archive.torrent` with web seeds.
2. Add each title to a `catalog.json` (licence, licence URL, attribution,
   provenance URL, infohash, `.torrent` path, video file index).
3. `TORRENT_DHT=true TORRENT_TRACKERS=true TORRENT_WEB_SEEDS=true CATALOG_DIR=<dir> pnpm start`.
4. Open `/player/` on: iPhone (Safari, iOS 17 and current), iPad (Safari),
   macOS (Safari), Windows (Edge/Chrome), and test: start, seek ±10 min, Arabic
   and English subtitles inline **and in native fullscreen**, AirPlay, lock
   screen/background, network throttling (Network Link Conditioner).
5. Run `mediastreamvalidator` on the master playlist and fix every
   "must fix" item.

## 7. Findings that changed the design

1. **`force_key_frames expr:` is unsafe for seek restarts.** `t` is relative
   to the job's first decoded frame; after `-ss` that can be up to one frame
   past the boundary, producing a one-frame overlap between jobs. Fixed by an
   absolute time list; covered by e2e test 7.
2. **Init segments differ between jobs** unless
   `-hls_segment_options movflags=+frag_discont` is used (edit list +
   relative `tfdt` otherwise). With it they are byte-identical and timestamps
   are absolute.
3. **Tokens must live in the path**, because the native player resolves
   relative URIs without the query string and cannot send headers.
4. **Chromium's native HLS exposes no subtitle renditions**; non-Apple
   platforms must use hls.js (matches the plan).
5. **Real-time 4K transcoding is not viable** per viewer → 4K only via
   passthrough or pre-packaging.
6. WebTorrent's `createReadStream({ end: 0 })` reads to EOF; the engine
   enforces exact lengths itself.
7. WebTorrent's chunk store leaves directories behind on destroy; the engine
   removes the torrent directory itself.
8. A literal U+200F in TypeScript source is invisible in review ("Trojan
   Source"); escapes are mandatory.
