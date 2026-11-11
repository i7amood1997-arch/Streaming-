import { avcCodecString, hevcCodecString } from '../codec-config.js';
import { MAX_INDEX_BYTES, UnsupportedSourceError } from './types.js';
import type { ByteRangeReader, KeyframeEntry, SourceIndex } from './types.js';

/**
 * Keyframe index for Matroska / WebM from the Cues element, located through
 * the SeekHead. Clusters are never read, so only the header region and the
 * Cues need to be fetched from the torrent. Files without a SeekHead entry
 * for Cues are reported as unsupported (indexing them would require reading
 * every cluster header across the whole file).
 */

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

interface Element {
  id: number;
  /** Offset of the payload within the buffer. */
  start: number;
  /** End of payload; -1 when the size is unknown. */
  end: number;
}

/** Reads an EBML variable-length integer. `keepMarker` for element IDs. */
function vint(
  buf: Uint8Array,
  pos: number,
  keepMarker: boolean,
): { value: number; length: number } {
  const first = buf[pos];
  if (first === undefined || first === 0) throw new UnsupportedSourceError('Invalid EBML vint');
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++;
  if (pos + length > buf.length) throw new RangeError('vint beyond buffer');
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const b = buf[pos + i] ?? 0;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value: !keepMarker && allOnes ? -1 : value, length };
}

function header(buf: Uint8Array, pos: number): Element & { headerLength: number } {
  const id = vint(buf, pos, true);
  const size = vint(buf, pos + id.length, false);
  const start = pos + id.length + size.length;
  return {
    id: id.value,
    start,
    end: size.value === -1 ? -1 : start + size.value,
    headerLength: id.length + size.length,
  };
}

function* elements(buf: Uint8Array, start: number, end: number): Generator<Element> {
  let pos = start;
  while (pos < end) {
    let h: ReturnType<typeof header>;
    try {
      h = header(buf, pos);
    } catch (err) {
      if (err instanceof RangeError) return; // truncated read window
      throw err;
    }
    if (h.end === -1 || h.end > end) {
      yield { id: h.id, start: h.start, end: Math.min(end, buf.length) };
      return;
    }
    yield h;
    pos = h.end;
  }
}

function uint(buf: Uint8Array, e: Element): number {
  let v = 0;
  for (let i = e.start; i < e.end; i++) v = v * 256 + (buf[i] ?? 0);
  return v;
}

function float(buf: Uint8Array, e: Element): number {
  const view = new DataView(buf.buffer, buf.byteOffset + e.start, e.end - e.start);
  if (e.end - e.start === 4) return view.getFloat32(0);
  if (e.end - e.start === 8) return view.getFloat64(0);
  return 0;
}

const text = (buf: Uint8Array, e: Element) =>
  new TextDecoder().decode(buf.subarray(e.start, e.end)).replace(/\0+$/, '');

async function readElement(reader: ByteRangeReader, offset: number): Promise<Uint8Array> {
  const head = await reader.read(offset, 16);
  const h = header(head, 0);
  if (h.end === -1) throw new UnsupportedSourceError('Index element with unknown size');
  const total = h.end;
  if (total > MAX_INDEX_BYTES) throw new UnsupportedSourceError('Index element too large');
  return reader.read(offset, total);
}

const HEAD_WINDOW = 256 * 1024;

export async function indexMkv(reader: ByteRangeReader): Promise<SourceIndex> {
  const head = await reader.read(0, Math.min(HEAD_WINDOW, reader.size));
  const ebml = header(head, 0);
  if (ebml.id !== ID.EBML || ebml.end === -1) throw new UnsupportedSourceError('Not an EBML file');
  let docType = 'matroska';
  for (const e of elements(head, ebml.start, ebml.end))
    if (e.id === ID.DocType) docType = text(head, e);
  if (docType !== 'matroska' && docType !== 'webm') {
    throw new UnsupportedSourceError(`Unsupported EBML DocType ${docType}`);
  }
  const segment = header(head, ebml.end);
  if (segment.id !== ID.Segment) throw new UnsupportedSourceError('Missing Segment');
  const segmentStart = segment.start;
  const segmentEnd = segment.end === -1 ? reader.size : Math.min(segment.end, reader.size);

  // Top-level elements: from the head window, or via SeekHead positions.
  const located = new Map<number, Uint8Array>();
  const seekPositions = new Map<number, number>();
  let pos = segmentStart;
  while (pos < head.length) {
    let e: ReturnType<typeof header>;
    try {
      e = header(head, pos);
    } catch (err) {
      if (err instanceof RangeError) break; // header straddles the window
      throw err;
    }
    if (e.end === -1) break; // unknown-size element (live-written cluster)
    const complete = e.end <= head.length;
    if (e.id === ID.SeekHead && complete) {
      for (const seek of elements(head, e.start, e.end)) {
        if (seek.id !== ID.Seek) continue;
        let target = 0;
        let position = -1;
        for (const f of elements(head, seek.start, seek.end)) {
          if (f.id === ID.SeekID) target = uint(head, f);
          if (f.id === ID.SeekPosition) position = uint(head, f);
        }
        if (position >= 0 && !seekPositions.has(target)) seekPositions.set(target, position);
      }
    } else if (e.id === ID.Info || e.id === ID.Tracks || e.id === ID.Cues) {
      if (complete) located.set(e.id, head.subarray(e.start, e.end));
      // Partially inside the window: remember where it starts and fetch it whole.
      else if (!seekPositions.has(e.id)) seekPositions.set(e.id, pos - segmentStart);
    }
    pos = e.end;
  }
  const load = async (id: number): Promise<Uint8Array | undefined> => {
    const inHead = located.get(id);
    if (inHead) return inHead;
    const pos = seekPositions.get(id);
    if (pos === undefined) return undefined;
    const raw = await readElement(reader, segmentStart + pos);
    const h = header(raw, 0);
    if (h.id !== id) throw new UnsupportedSourceError('SeekHead points to the wrong element');
    return raw.subarray(h.start, h.end);
  };

  const info = await load(ID.Info);
  const tracks = await load(ID.Tracks);
  const cues = await load(ID.Cues);
  if (!info || !tracks) throw new UnsupportedSourceError('Missing Info or Tracks');
  if (!cues) throw new UnsupportedSourceError('No Cues reachable through the SeekHead');

  let timestampScale = 1_000_000;
  let durationTicks = 0;
  for (const e of elements(info, 0, info.length)) {
    if (e.id === ID.TimestampScale) timestampScale = uint(info, e);
    if (e.id === ID.Duration) durationTicks = float(info, e);
  }
  const ticksToSec = timestampScale / 1e9;

  let videoTrack: { number: number; codecId: string; priv: Uint8Array | undefined } | undefined;
  for (const entry of elements(tracks, 0, tracks.length)) {
    if (entry.id !== ID.TrackEntry) continue;
    let number = 0;
    let type = 0;
    let codecId = '';
    let priv: Uint8Array | undefined;
    for (const f of elements(tracks, entry.start, entry.end)) {
      if (f.id === ID.TrackNumber) number = uint(tracks, f);
      if (f.id === ID.TrackType) type = uint(tracks, f);
      if (f.id === ID.CodecID) codecId = text(tracks, f);
      if (f.id === ID.CodecPrivate) priv = tracks.subarray(f.start, f.end);
    }
    if (type === 1) {
      videoTrack = { number, codecId, priv };
      break;
    }
  }
  if (!videoTrack) throw new UnsupportedSourceError('No video track');

  let codec: SourceIndex['video']['codec'] = 'other';
  let codecString: string | null = null;
  if (videoTrack.codecId === 'V_MPEG4/ISO/AVC') {
    codec = 'h264';
    codecString = videoTrack.priv ? avcCodecString(videoTrack.priv) : null;
  } else if (videoTrack.codecId === 'V_MPEGH/ISO/HEVC') {
    codec = 'hevc';
    codecString = videoTrack.priv ? hevcCodecString(videoTrack.priv) : null;
  }

  const keyframes: KeyframeEntry[] = [];
  for (const point of elements(cues, 0, cues.length)) {
    if (point.id !== ID.CuePoint) continue;
    let time = -1;
    for (const f of elements(cues, point.start, point.end)) {
      if (f.id === ID.CueTime) time = uint(cues, f);
      if (f.id !== ID.CueTrackPositions || time < 0) continue;
      let track = 0;
      let cluster = -1;
      for (const g of elements(cues, f.start, f.end)) {
        if (g.id === ID.CueTrack) track = uint(cues, g);
        if (g.id === ID.CueClusterPosition) cluster = uint(cues, g);
      }
      if (track === videoTrack.number && cluster >= 0) {
        keyframes.push({ timeSec: time * ticksToSec, byteMark: segmentStart + cluster });
      }
    }
  }
  keyframes.sort((a, b) => a.timeSec - b.timeSec);
  if (keyframes.length === 0) throw new UnsupportedSourceError('Cues contain no video keyframes');

  return {
    container: 'matroska',
    durationSec: durationTicks * ticksToSec,
    video: { codec, codecString, keyframes, endByteMark: segmentEnd, videoOnlyBytes: false },
  };
}
