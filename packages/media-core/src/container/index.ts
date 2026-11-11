import { indexMkv } from './mkv.js';
import { indexMp4 } from './mp4.js';
import { UnsupportedSourceError } from './types.js';
import type { ByteRangeReader, SourceIndex } from './types.js';

export * from './types.js';
export { indexMkv } from './mkv.js';
export { indexMp4 } from './mp4.js';

/** Sniffs the container and builds its keyframe index (MP4/MOV or Matroska/WebM). */
export async function indexSource(reader: ByteRangeReader): Promise<SourceIndex> {
  const magic = await reader.read(0, 12);
  if (magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3) {
    return indexMkv(reader);
  }
  const type = String.fromCharCode(...magic.subarray(4, 8));
  if (['ftyp', 'moov', 'free', 'skip', 'wide', 'mdat'].includes(type)) return indexMp4(reader);
  throw new UnsupportedSourceError('Container is neither MP4 nor Matroska');
}
