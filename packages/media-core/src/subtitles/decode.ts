import { languageInfo } from './language.js';

export interface DecodedText {
  text: string;
  encoding: string;
}

/**
 * Decodes subtitle bytes to a JS string. Order: BOM -> strict UTF-8 -> the
 * legacy code page typical for the track language (e.g. Windows-1256 for
 * Arabic, which is how a large share of Arabic .srt files are still encoded).
 * Deterministic on purpose; statistical charset sniffing is avoided because it
 * misfires on the short texts subtitles often are.
 */
export function decodeSubtitleBytes(bytes: Uint8Array, language?: string): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    const encoding = languageInfo(language ?? 'en').legacyEncoding;
    return { text: new TextDecoder(encoding).decode(bytes), encoding };
  }
}

/**
 * Encodes text into a single-byte legacy code page (e.g. Windows-1256) using
 * the platform decoder table. Used to produce realistic legacy subtitle files
 * for fixtures and tests; throws on characters the code page cannot represent.
 */
export function encodeSingleByte(text: string, encoding: string): Buffer {
  const decoder = new TextDecoder(encoding);
  const table = new Map<string, number>();
  for (let b = 0; b < 256; b++) table.set(decoder.decode(Uint8Array.of(b)), b);
  const out: number[] = [];
  for (const ch of text) {
    const byte = table.get(ch);
    if (byte === undefined) {
      throw new Error(
        `U+${(ch.codePointAt(0) ?? 0).toString(16)} is not representable in ${encoding}`,
      );
    }
    out.push(byte);
  }
  return Buffer.from(out);
}
