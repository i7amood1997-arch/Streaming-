/**
 * Arabic/Hebrew cue normalisation for WebVTT.
 *
 * In native fullscreen on iPhone the system player renders cues and page CSS
 * (`direction: rtl`) does not apply, so direction has to be carried inside the
 * text itself. WebVTT applies the Unicode bidi algorithm per line with the
 * paragraph direction taken from the first strong character; a line that
 * starts with a digit, Latin word or punctuation is therefore laid out LTR and
 * trailing punctuation jumps to the wrong side.
 *
 * Fix: wrap every line that contains RTL letters in RIGHT-TO-LEFT MARKs
 * (U+200F). The leading RLM fixes the paragraph direction; the trailing one
 * keeps final punctuation at the visual end (left).
 */
export const RLM = '\u200F';

const RTL_CHAR = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const EDGE_BIDI_CONTROLS =
  /^[\u200E\u200F\u202A-\u202E\u2066-\u2069]+|[\u200E\u200F\u202A-\u202E\u2066-\u2069]+$/gu;
/** Sentence punctuation incorrectly stored in visual order at the start of a line. */
const LEADING_PUNCTUATION = /^([.!?؟,،:;…]+)(\s*)(?=[\p{Script=Arabic}\p{Script=Hebrew}])/u;

export interface RtlOptions {
  /**
   * Repair files authored in visual order (".مرحبا" instead of "مرحبا."),
   * a common artefact of legacy subtitle editors.
   */
  fixReversedPunctuation: boolean;
}

export function normalizeRtlLine(line: string, opts: RtlOptions): string {
  let text = line.replace(EDGE_BIDI_CONTROLS, '');
  if (!RTL_CHAR.test(text)) return line;
  if (opts.fixReversedPunctuation) {
    const match = LEADING_PUNCTUATION.exec(text);
    if (match) {
      const [whole, punctuation = ''] = match;
      text = `${text.slice(whole.length)}${punctuation}`;
    }
  }
  return `${RLM}${text}${RLM}`;
}

export function normalizeRtlText(text: string, opts: RtlOptions): string {
  return text
    .split('\n')
    .map((line) => normalizeRtlLine(line, opts))
    .join('\n');
}
