# M2a — Copy (remux) mode and 4K passthrough

Date: 2026-11-11 · Code: `packages/media-core/src/container/*`, `copy-timeline.ts`,
`ffmpeg-args.ts` (`buildCopySegmentArgs`), `apps/media-worker/src/session/copy-producer.ts`.

## 1. Goal

Serve Safari-compatible sources (H.264, or HEVC to HEVC-capable clients, with
AAC-LC audio) **without re-encoding**: original quality, near-zero CPU, and the
only viable path to 4K. The constraint is the same as for transcoding: Safari
needs a complete VOD playlist up front, so every segment boundary must be known
before any bytes are copied, and segments from different ffmpeg runs must fit
together exactly.

## 2. Design

1. **Keyframe index from the container, read through byte ranges.**
   - MP4: box headers until `moov` (it may be at the end of the file), then
     `stts`/`ctts`/`stss`/`stsz`/`elst` and `avcC`/`hvcC`. `mdat` is never read.
   - Matroska: EBML header, SeekHead → Info, Tracks, Cues. Clusters are never read.
   - Refused as `UnsupportedSourceError`, which falls back to transcoding: fragmented
     MP4, Matroska without SeekHead-referenced Cues, multi-segment edit lists.
2. **Boundaries:** the first keyframe at least the target duration (6 s) after the
   previous boundary, skipping keyframes followed by another within 0.3 s and
   never leaving a tail shorter than 1 s. Long GOPs make longer segments
   (copy cannot cut inside a GOP).
3. **One ffmpeg run per segment** (`-c copy`), seeking to `boundary + 0.2 s`,
   with `hls_time` just under the segment length so the HLS muxer splits exactly
   on the next boundary's keyframe packet. The partial next segment is discarded.
4. **Exact codec strings** for the `CODECS` attribute from `avcC`/`hvcC`
   (RFC 6381 / ISO/IEC 14496-15 Annex E); HEVC is always written as `hvc1`.
5. **Drift check:** every run's actual segment length (from ffmpeg's playlist)
   is compared with the plan; deviations above 0.1 s increment `driftEvents`.

## 3. Findings (each reproduced before being designed around)

| #   | Finding                                                                                                                                 | Consequence                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Input `-to` with stream copy cuts by **decode** time: each segment also got the next GOP's IDR + P-frame (1449 packets instead of 1439) | Cut with the HLS muxer instead (`hls_time` just under the segment length): exact 1439/1439       |
| 2   | `-start_at_zero` shifts the **seek target** by the file's `start_time` (−0.021 s from AAC priming in MKV), landing one keyframe early   | Copy mode uses the container's raw timestamps, no `-start_at_zero`                               |
| 3   | For DTS-seeking demuxers (Matroska) ffmpeg's CLI pulls the seek target back ≈0.13 s when B-frames exist, landing one keyframe early     | Seek to `boundary + 0.2 s`; boundaries require ≥ 0.3 s to the next keyframe                      |
| 4   | Stream copy does not drop packets before `-ss`, so the output still starts exactly at the boundary keyframe                             | Offset seek is safe                                                                              |
| 5   | Init segments are byte-identical across runs with `movflags=+frag_discont` (H.264 and HEVC/`hvc1`)                                      | One canonical `init.mp4` per session, as in transcode mode                                       |
| 6   | One AAC frame (≈21 ms) appears in both neighbouring segments at each boundary                                                           | Harmless overlap resolved by timestamps (MSE replaces overlapping frames); documented, not fixed |
| 7   | Open-GOP HEVC (x265 default) has leading pictures after a CRA keyframe that reference the previous GOP                                  | Continuous playback is unaffected; after a seek decoders skip them. **Unverified on Safari**     |

## 4. Evidence (automated)

`packages/media-core/test/container.test.ts` (ffmpeg-generated files):

- Index keyframe times equal ffprobe's keyframe **packet** pts for: MP4 with
  moov at end, faststart MP4, MP4 without edit list (B-frames), H.264 MKV,
  HEVC MKV. Indexing reads **< 15 %** of each file.
- Fragmented MP4, Matroska without Cues and garbage input are refused.
- Codec strings: ISO/IEC 14496-15 vectors (`hvc1.1.6.L93.B0`, high tier/two
  constraint bytes) and agreement with ffprobe profile/level.

`apps/media-worker/test/e2e/copy.e2e.test.ts` (local BitTorrent swarm):

| Check                                                                                               | Result |
| --------------------------------------------------------------------------------------------------- | ------ |
| 1080p H.264 MP4, quality `auto` → copy; `CODECS` equals the source's `avcC`                         | ✅     |
| Every boundary is a source keyframe; segments ≥ 6 s except the last                                 | ✅     |
| Segments fetched out of order (seek first); assembled video packets = source packets, no duplicates | ✅     |
| Chromium + hls.js plays copied segments at 1080p and seeks to 60 s                                  | ✅     |
| 4K HEVC Main 10 MKV → copy for HEVC clients: 3840×2160, `hvc1`, packet count = source               | ✅     |
| Same 4K title for a non-HEVC 1080p client → 1080p H.264 transcode with reasons                      | ✅     |
| `driftEvents` = 0 in all copy sessions                                                              | ✅     |

Cost on this machine (4 vCPU): one 6 s 4K HEVC segment by copy **95 ms** wall;
the same 6 s transcoded to 1080p H.264 **4.3 s** wall with all cores busy.

## 5. M2b — copy video + separate audio rendition

Sources whose audio Safari/MSE cannot play (AC-3, E-AC-3, DTS, multichannel)
keep their video copied; only the audio is transcoded, to AAC-LC stereo, as a
separate HLS rendition (`EXT-X-MEDIA TYPE=AUDIO`, `AUDIO="aud"` on the variant,
`NAME` = language endonym, `LANGUAGE`, `CHANNELS="2"`). Video segments then
carry no audio.

- The audio job cuts on time (`hls_time = d`; every AAC frame is a cut point)
  in raw container time like copied video. Measured: a job restarted at 24 s
  produced segments 4–6 with the same first/last timestamps and packet counts
  as a continuous job (282/281/188) and a byte-identical init segment.
- Defect found and fixed: a time-cut producer writes the title's final
  fraction of a second as an extra segment beyond the playlist (the shared
  timeline merges tails shorter than 1 s, which is right for video). The last
  listed segment is now only served after the producer exits, with overflow
  fragments appended to it. The e2e test compares the served audio's end with
  the source and was shown to fail without the fix.

Evidence (`copy.e2e.test.ts`, 720p H.264 + AC-3 5.1 English MKV): decisions
`COPY` + `AUDIO_SEPARATE_RENDITION`; master declares the English AAC rendition;
video segments contain only video, packet-exact; audio segments fetched with a
seek first are AAC-LC 2 ch 48 kHz, strictly increasing timestamps, no gap above
one AAC frame across the restart boundary, ending with the source; Chromium +
hls.js plays and seeks with the alternate rendition.

## 6. Not covered yet

- Multiple audio languages (the planner picks one stream); AC-3/E-AC-3 5.1
  passthrough renditions for Apple devices.
- HEVC/4K playback on a real Safari/Apple device (Chromium cannot decode HEVC).
  HDR sources are copied with `VIDEO-RANGE=PQ|HLG` in the master playlist
  (unit-tested), but no HDR source has been played on HDR hardware yet.
- Real-world files (Blender/Internet Archive) — blocked by network access here.
