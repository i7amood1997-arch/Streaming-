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
