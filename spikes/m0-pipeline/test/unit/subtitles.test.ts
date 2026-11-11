import { describe, expect, it } from 'vitest';
import { arabicSubtitles, encodeWindows1256 } from '../../src/fixtures/generate.js';
import { decodeSubtitleBytes } from '../../src/subtitles/decode.js';
import { detectSidecarSubtitles, normalizeLanguage } from '../../src/subtitles/language.js';
import { RLM, normalizeRtlLine, normalizeRtlText } from '../../src/subtitles/rtl.js';
import { parseCues, sanitizeCueText, toWebVtt } from '../../src/subtitles/webvtt.js';

const fix = { fixReversedPunctuation: true };

describe('decodeSubtitleBytes', () => {
  it('honours BOMs', () => {
    expect(decodeSubtitleBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toEqual({
      text: 'hi',
      encoding: 'utf-8',
    });
    expect(decodeSubtitleBytes(Uint8Array.from([0xff, 0xfe, 0x68, 0x00]))).toEqual({
      text: 'h',
      encoding: 'utf-16le',
    });
    expect(decodeSubtitleBytes(Uint8Array.from([0xfe, 0xff, 0x00, 0x68]))).toEqual({
      text: 'h',
      encoding: 'utf-16be',
    });
  });

  it('accepts valid UTF-8 Arabic as-is', () => {
    const bytes = new TextEncoder().encode('مرحبا');
    expect(decodeSubtitleBytes(bytes, 'ar')).toEqual({ text: 'مرحبا', encoding: 'utf-8' });
  });

  it('falls back to Windows-1256 for legacy Arabic files', () => {
    const original = 'هل تسمع الصوت؟ 1080p';
    const result = decodeSubtitleBytes(encodeWindows1256(original), 'ar');
    expect(result).toEqual({ text: original, encoding: 'windows-1256' });
  });

  it('uses Windows-1252 for unknown languages', () => {
    expect(decodeSubtitleBytes(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])).text).toBe('café');
  });
});

describe('language detection', () => {
  it('maps ISO 639-2 codes and finds sidecar files', () => {
    expect(normalizeLanguage('ARA')).toBe('ar');
    expect(normalizeLanguage('xx')).toBeUndefined();
    const found = detectSidecarSubtitles([
      { index: 0, name: 'Movie.mp4' },
      { index: 1, name: 'Movie.en.srt' },
      { index: 2, name: 'Movie.ara.forced.srt' },
      { index: 3, name: 'Movie.zz.srt' },
      { index: 4, name: 'notes.txt' },
    ]);
    expect(found).toEqual([
      { fileIndex: 1, language: 'en', forced: false, format: 'srt' },
      { fileIndex: 2, language: 'ar', forced: true, format: 'srt' },
    ]);
  });
});

describe('parseCues', () => {
  it('parses messy SubRip (CRLF, dots, missing counters, hours omitted)', () => {
    const cues = parseCues(
      '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\nworld\r\n\r\n00:00:03.5 --> 00:00:04.000 X:1\r\nNo counter\r\n\r\n3\r\n00:05,000 --> 00:06,000\r\nshort\r\n',
    );
    expect(cues).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Hello\nworld' },
      { startMs: 3500, endMs: 4000, text: 'No counter' },
      { startMs: 5000, endMs: 6000, text: 'short' },
    ]);
  });

  it('skips WebVTT headers, NOTE blocks, empty and inverted cues', () => {
    const cues = parseCues(
      'WEBVTT\n\nNOTE hello\n\n00:00:02.000 --> 00:00:01.000\nbackwards\n\n00:00:03.000 --> 00:00:04.000\n\n00:00:05.000 --> 00:00:06.000\nok\n',
    );
    expect(cues).toEqual([{ startMs: 5000, endMs: 6000, text: 'ok' }]);
  });
});

describe('sanitizeCueText', () => {
  it('keeps i/b/u, drops other tags and ASS overrides, escapes markup', () => {
    expect(sanitizeCueText('{\\an8}<I>Hi</I> <font color="red">&</font> a < b --> c')).toBe(
      '<i>Hi</i> &amp; a &lt; b --&gt; c',
    );
  });
});

describe('RTL normalisation', () => {
  it('wraps Arabic lines in RLM and leaves Latin lines alone', () => {
    expect(normalizeRtlLine('مرحبا', fix)).toBe(`${RLM}مرحبا${RLM}`);
    expect(normalizeRtlLine('Hello', fix)).toBe('Hello');
  });

  it('forces RTL for lines starting with digits or Latin text', () => {
    expect(normalizeRtlLine('1080p متاحة الآن.', fix)).toBe(`${RLM}1080p متاحة الآن.${RLM}`);
  });

  it('repairs punctuation stored in visual order', () => {
    expect(normalizeRtlLine('؟هل تسمع الصوت بوضوح', fix)).toBe(`${RLM}هل تسمع الصوت بوضوح؟${RLM}`);
    expect(normalizeRtlLine('.مرحبا', { fixReversedPunctuation: false })).toBe(
      `${RLM}.مرحبا${RLM}`,
    );
  });

  it('keeps dialogue dashes and is idempotent', () => {
    const once = normalizeRtlText('- نعم، الصوت واضح.\n- ممتاز!', fix);
    expect(once).toBe(`${RLM}- نعم، الصوت واضح.${RLM}\n${RLM}- ممتاز!${RLM}`);
    expect(normalizeRtlText(once, fix)).toBe(once);
  });
});

describe('toWebVtt', () => {
  it('emits a WebVTT file with X-TIMESTAMP-MAP for HLS', () => {
    const vtt = toWebVtt([{ startMs: 3_723_004, endMs: 3_724_000, text: 'Hi' }], { rtl: null });
    expect(vtt).toBe(
      'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n01:02:03.004 --> 01:02:04.000\nHi\n',
    );
  });

  it('converts the Windows-1256 fixture end to end', () => {
    const { text } = decodeSubtitleBytes(encodeWindows1256(arabicSubtitles()), 'ar');
    const vtt = toWebVtt(parseCues(text), { rtl: fix });
    expect(vtt).toContain(`00:00:10.000 --> 00:00:14.000\n${RLM}هل تسمع الصوت بوضوح؟${RLM}\n`);
    expect(vtt).not.toContain('\r');
  });
});
