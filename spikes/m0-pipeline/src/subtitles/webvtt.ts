import { normalizeRtlText } from './rtl.js';
import type { RtlOptions } from './rtl.js';

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

const TIMING =
  /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

function toMs(h: string | undefined, m: string, s: string, frac: string): number {
  const ms = Number(frac.padEnd(3, '0'));
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + ms;
}

/**
 * Lenient parser for SubRip and WebVTT cue blocks. Real-world .srt files
 * routinely have missing counters, `.` instead of `,`, CRLF/CR line endings,
 * stray whitespace and HTML/ASS styling; all are tolerated here.
 */
export function parseCues(input: string): Cue[] {
  const text = input.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i) => i > 0 || l.trim() !== '');
    const timingIdx = lines.findIndex((l) => TIMING.test(l));
    if (timingIdx === -1 || timingIdx > 1) continue; // header, NOTE, STYLE or garbage
    const m = TIMING.exec(lines[timingIdx] ?? '');
    if (!m) continue;
    const startMs = toMs(m[1], m[2] ?? '0', m[3] ?? '0', m[4] ?? '0');
    const endMs = toMs(m[5], m[6] ?? '0', m[7] ?? '0', m[8] ?? '0');
    const body = lines
      .slice(timingIdx + 1)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '')
      .join('\n');
    if (endMs <= startMs || body === '') continue;
    cues.push({ startMs, endMs, text: body });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

const ALLOWED_TAG = /^<\/?(?:i|b|u)>$/i;

/** Keeps only WebVTT-safe markup: <i>, <b>, <u>; escapes everything else. */
export function sanitizeCueText(text: string): string {
  const withoutAss = text.replace(/\{\\[^}]*\}/g, '');
  return withoutAss
    .split(/(<\/?[a-zA-Z][^<>]*>)/g)
    .map((part, i) => {
      // Odd indices are the captured tag-like tokens.
      if (i % 2 === 1) {
        return ALLOWED_TAG.test(part) ? part.toLowerCase() : '';
      }
      return part
        .replace(/&(?!(?:amp|lt|gt|lrm|rlm|nbsp);)/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/-->/g, '--&gt;');
    })
    .join('')
    .trim();
}

function formatTimestamp(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(frac, 3)}`;
}

export interface WebVttOptions {
  rtl: RtlOptions | null;
}

/**
 * Serialises cues to WebVTT for HLS. X-TIMESTAMP-MAP ties cue time 0 to media
 * time 0: the transcoder preserves source timestamps (-copyts -start_at_zero),
 * so fMP4 media time equals presentation time.
 */
export function toWebVtt(cues: Cue[], opts: WebVttOptions): string {
  const out = ['WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000', ''];
  for (const cue of cues) {
    let body = sanitizeCueText(cue.text);
    if (body === '') continue;
    if (opts.rtl) body = normalizeRtlText(body, opts.rtl);
    out.push(`${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`, body, '');
  }
  return out.join('\n');
}
