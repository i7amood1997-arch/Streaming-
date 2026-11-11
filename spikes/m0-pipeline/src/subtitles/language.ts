/** Minimal language metadata needed for subtitle tracks. Extend as languages are added. */
interface LanguageInfo {
  /** BCP 47 tag written to the HLS LANGUAGE attribute. */
  tag: string;
  /** Endonym shown in the native iOS subtitle menu (HLS NAME attribute). */
  nativeName: string;
  rtl: boolean;
  /** Legacy single-byte code page commonly used by subtitle files in this language. */
  legacyEncoding: string;
}

const LANGUAGES: Readonly<Record<string, LanguageInfo>> = {
  en: { tag: 'en', nativeName: 'English', rtl: false, legacyEncoding: 'windows-1252' },
  ar: { tag: 'ar', nativeName: 'العربية', rtl: true, legacyEncoding: 'windows-1256' },
  fa: { tag: 'fa', nativeName: 'فارسی', rtl: true, legacyEncoding: 'windows-1256' },
  he: { tag: 'he', nativeName: 'עברית', rtl: true, legacyEncoding: 'windows-1255' },
  fr: { tag: 'fr', nativeName: 'Français', rtl: false, legacyEncoding: 'windows-1252' },
  es: { tag: 'es', nativeName: 'Español', rtl: false, legacyEncoding: 'windows-1252' },
  de: { tag: 'de', nativeName: 'Deutsch', rtl: false, legacyEncoding: 'windows-1252' },
  ru: { tag: 'ru', nativeName: 'Русский', rtl: false, legacyEncoding: 'windows-1251' },
};

const ISO639_2_TO_1: Readonly<Record<string, string>> = {
  eng: 'en',
  ara: 'ar',
  fas: 'fa',
  per: 'fa',
  heb: 'he',
  fra: 'fr',
  fre: 'fr',
  spa: 'es',
  deu: 'de',
  ger: 'de',
  rus: 'ru',
};

export function normalizeLanguage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const lower = code.toLowerCase();
  const short = ISO639_2_TO_1[lower] ?? lower;
  return short in LANGUAGES ? short : undefined;
}

export function languageInfo(code: string): LanguageInfo {
  return (
    LANGUAGES[code] ?? { tag: code, nativeName: code, rtl: false, legacyEncoding: 'windows-1252' }
  );
}

/**
 * Finds sidecar subtitle files for a video inside a torrent, using the common
 * `<name>.<lang>[.forced].srt|vtt` convention.
 */
export function detectSidecarSubtitles(
  files: readonly { index: number; name: string }[],
): { fileIndex: number; language: string; forced: boolean; format: 'srt' | 'vtt' }[] {
  const out: { fileIndex: number; language: string; forced: boolean; format: 'srt' | 'vtt' }[] = [];
  for (const file of files) {
    const match = /\.([a-z]{2,3})(\.forced)?\.(srt|vtt)$/i.exec(file.name);
    if (!match) continue;
    const language = normalizeLanguage(match[1]);
    if (!language) continue;
    out.push({
      fileIndex: file.index,
      language,
      forced: match[2] !== undefined,
      format: (match[3] ?? 'srt').toLowerCase() as 'srt' | 'vtt',
    });
  }
  return out;
}
