import { avcCodecString, hevcCodecString } from '../codec-config.js';
import { MAX_INDEX_BYTES, UnsupportedSourceError } from './types.js';
import type { ByteRangeReader, KeyframeEntry, SourceIndex } from './types.js';

/**
 * Keyframe index for progressive (non-fragmented) ISO-BMFF / MP4 files.
 *
 * Only box headers are read until `moov` is found (it may sit at the end of
 * the file), then `moov` itself — never `mdat`. Timestamps follow ffmpeg's
 * mov demuxer for the common cases: pts = dts + ctts − first edit's
 * media_time + leading empty-edit delay.
 */

interface Box {
  type: string;
  /** Offset of the payload within the containing buffer. */
  start: number;
  end: number;
}

function* children(view: DataView, start: number, end: number): Generator<Box> {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4),
      view.getUint8(pos + 5),
      view.getUint8(pos + 6),
      view.getUint8(pos + 7),
    );
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end)
      throw new UnsupportedSourceError(`Corrupt MP4 box ${type}`);
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function child(view: DataView, parent: Box, type: string): Box | undefined {
  for (const b of children(view, parent.start, parent.end)) if (b.type === type) return b;
  return undefined;
}

function path(view: DataView, parent: Box, types: string[]): Box | undefined {
  let cur: Box | undefined = parent;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(view, cur, t);
  }
  return cur;
}

async function readTopLevel(reader: ByteRangeReader): Promise<{ moov: Uint8Array }> {
  let pos = 0;
  while (pos + 8 <= reader.size) {
    const head = await reader.read(pos, 16);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = String.fromCharCode(head[4] ?? 0, head[5] ?? 0, head[6] ?? 0, head[7] ?? 0);
    if (size === 1) size = Number(view.getBigUint64(8));
    else if (size === 0) size = reader.size - pos;
    if (size < 8) throw new UnsupportedSourceError(`Corrupt top-level MP4 box ${type}`);
    if (type === 'moof') throw new UnsupportedSourceError('Fragmented MP4 is not indexable');
    if (type === 'moov') {
      if (size > MAX_INDEX_BYTES) throw new UnsupportedSourceError('moov box too large');
      return { moov: await reader.read(pos, size) };
    }
    pos += size;
  }
  throw new UnsupportedSourceError('No moov box found');
}

interface Track {
  handler: string;
  timescale: number;
  durationUnits: number;
  stbl: Box;
  edts: Box | undefined;
}

function parseTrack(view: DataView, trak: Box): Track | undefined {
  const mdia = child(view, trak, 'mdia');
  if (!mdia) return undefined;
  const hdlr = child(view, mdia, 'hdlr');
  const mdhd = child(view, mdia, 'mdhd');
  const stbl = path(view, mdia, ['minf', 'stbl']);
  if (!hdlr || !mdhd || !stbl) return undefined;
  const handler = String.fromCharCode(
    view.getUint8(hdlr.start + 8),
    view.getUint8(hdlr.start + 9),
    view.getUint8(hdlr.start + 10),
    view.getUint8(hdlr.start + 11),
  );
  const v1 = view.getUint8(mdhd.start) === 1;
  const timescale = view.getUint32(mdhd.start + (v1 ? 20 : 12));
  const durationUnits = v1
    ? Number(view.getBigUint64(mdhd.start + 24))
    : view.getUint32(mdhd.start + 16);
  return { handler, timescale, durationUnits, stbl, edts: child(view, trak, 'edts') };
}

/** Shift (in media timescale units) that ffmpeg applies from the edit list. */
function editShift(view: DataView, track: Track, movieTimescale: number): number {
  const elst = track.edts ? child(view, track.edts, 'elst') : undefined;
  if (!elst) return 0;
  const v1 = view.getUint8(elst.start) === 1;
  const count = view.getUint32(elst.start + 4);
  const entrySize = v1 ? 20 : 12;
  let emptyDelay = 0;
  let mediaTime: number | undefined;
  let nonEmpty = 0;
  for (let i = 0; i < count; i++) {
    const p = elst.start + 8 + i * entrySize;
    const segDuration = v1 ? Number(view.getBigUint64(p)) : view.getUint32(p);
    const time = v1 ? Number(view.getBigInt64(p + 8)) : view.getInt32(p + 4);
    if (time === -1) {
      if (nonEmpty === 0) emptyDelay += (segDuration / movieTimescale) * track.timescale;
      continue;
    }
    nonEmpty += 1;
    mediaTime ??= time;
  }
  if (nonEmpty > 1)
    throw new UnsupportedSourceError('Multi-segment MP4 edit lists are not supported');
  return emptyDelay - (mediaTime ?? 0);
}

function sampleEntryConfig(
  view: DataView,
  stbl: Box,
): { codec: SourceIndex['video']['codec']; codecString: string | null } {
  const stsd = child(view, stbl, 'stsd');
  if (!stsd) throw new UnsupportedSourceError('Missing stsd');
  const next = children(view, stsd.start + 8, stsd.end).next();
  if (next.done) throw new UnsupportedSourceError('Empty stsd');
  const first: Box = next.value;
  const isAvc = first.type === 'avc1' || first.type === 'avc3';
  const isHevc = first.type === 'hvc1' || first.type === 'hev1';
  if (!isAvc && !isHevc) return { codec: 'other', codecString: null };
  // VisualSampleEntry: 78 bytes of fixed fields before child boxes.
  for (const b of children(view, first.start + 78, first.end)) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + b.start, b.end - b.start);
    if (isAvc && b.type === 'avcC') return { codec: 'h264', codecString: avcCodecString(bytes) };
    if (isHevc && b.type === 'hvcC') return { codec: 'hevc', codecString: hevcCodecString(bytes) };
  }
  return { codec: isAvc ? 'h264' : 'hevc', codecString: null };
}

export async function indexMp4(reader: ByteRangeReader): Promise<SourceIndex> {
  const { moov } = await readTopLevel(reader);
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const root: Box = { type: 'root', start: 0, end: moov.length };
  const moovBox = child(view, root, 'moov');
  if (!moovBox) throw new UnsupportedSourceError('Unreadable moov');
  if (child(view, moovBox, 'mvex'))
    throw new UnsupportedSourceError('Fragmented MP4 is not indexable');
  const mvhd = child(view, moovBox, 'mvhd');
  if (!mvhd) throw new UnsupportedSourceError('Missing mvhd');
  const movieTimescale = view.getUint32(mvhd.start + (view.getUint8(mvhd.start) === 1 ? 20 : 12));

  let video: Track | undefined;
  for (const b of children(view, moovBox.start, moovBox.end)) {
    if (b.type !== 'trak') continue;
    const t = parseTrack(view, b);
    if (t?.handler === 'vide') {
      video = t;
      break;
    }
  }
  if (!video) throw new UnsupportedSourceError('No video track');
  const { stbl, timescale } = video;

  // Decode times (stts).
  const stts = child(view, stbl, 'stts');
  const stsz = child(view, stbl, 'stsz');
  if (!stts || !stsz) throw new UnsupportedSourceError('Missing stts/stsz');
  const sampleCount = view.getUint32(stsz.start + 8);
  const dts = new Float64Array(sampleCount);
  {
    const n = view.getUint32(stts.start + 4);
    let i = 0;
    let t = 0;
    for (let e = 0; e < n; e++) {
      const count = view.getUint32(stts.start + 8 + e * 8);
      const delta = view.getUint32(stts.start + 12 + e * 8);
      for (let c = 0; c < count && i < sampleCount; c++, i++) {
        dts[i] = t;
        t += delta;
      }
    }
  }
  // Composition offsets (ctts); ffmpeg treats both versions as signed.
  const cts = new Float64Array(dts);
  const ctts = child(view, stbl, 'ctts');
  if (ctts) {
    const n = view.getUint32(ctts.start + 4);
    let i = 0;
    for (let e = 0; e < n; e++) {
      const count = view.getUint32(ctts.start + 8 + e * 8);
      const offset = view.getInt32(ctts.start + 12 + e * 8);
      for (let c = 0; c < count && i < sampleCount; c++, i++) cts[i] = (cts[i] ?? 0) + offset;
    }
  }
  // Sample sizes (stsz) -> cumulative byte marks.
  const marks = new Float64Array(sampleCount + 1);
  {
    const fixed = view.getUint32(stsz.start + 4);
    for (let i = 0; i < sampleCount; i++) {
      const size = fixed !== 0 ? fixed : view.getUint32(stsz.start + 12 + i * 4);
      marks[i + 1] = (marks[i] ?? 0) + size;
    }
  }
  // Sync samples (stss); absent means every sample is a sync sample.
  const stss = child(view, stbl, 'stss');
  const syncIndices: number[] = [];
  if (stss) {
    const n = view.getUint32(stss.start + 4);
    for (let e = 0; e < n; e++) syncIndices.push(view.getUint32(stss.start + 8 + e * 4) - 1);
  } else {
    for (let i = 0; i < sampleCount; i++) syncIndices.push(i);
  }

  const shift = editShift(view, video, movieTimescale);
  const keyframes: KeyframeEntry[] = syncIndices
    .filter((i) => i >= 0 && i < sampleCount)
    .map((i) => ({ timeSec: ((cts[i] ?? 0) + shift) / timescale, byteMark: marks[i] ?? 0 }))
    .sort((a, b) => a.timeSec - b.timeSec);

  return {
    container: 'mp4',
    durationSec: video.durationUnits / timescale,
    video: {
      ...sampleEntryConfig(view, stbl),
      keyframes,
      endByteMark: marks[sampleCount] ?? 0,
      videoOnlyBytes: true,
    },
  };
}
