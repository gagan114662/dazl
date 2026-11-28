// The words that cannot be part of a role, in ONE table for every language dazl reads. A word here turns a hiring phrase into a
// denial ("hiring nobody", "keine SDRs", "nadie") or an impossibility ("hiring SDRs impossible", "unmöglich"). Keyed by ISO 639-1.
//
// Two rules make this safe for a language it does not cover:
//   1. a language absent from this table is never judged by English words - readsLanguage() says so, and the caller must get its
//      reading from the judge (lib/scan/signal-reading.ts) instead of passing the phrase;
//   2. a language whose script has no spaces (Japanese) cannot be judged word by word either, so it is read the same way - by the
//      judge - and its row below only ever catches a whole role that is one of these words.
export const NOT_A_ROLE: Record<string, readonly string[]> = {
  en: ['is', 'are', 'was', 'were', 'be', 'been', 'has', 'had', 'off', 'out', 'down', 'up', 'over', 'anymore', 'yet', 'not', 'never',
    'no', 'none', 'nobody', 'nothing', 'any', 'anyone', 'anybody', 'neither', 'nor', 'zero', 'nil', 'zilch', 'minimal', 'impossible',
    'unlikely', 'frozen', 'froze', 'fewer', 'less', 'few'],
  de: ['ist', 'sind', 'war', 'waren', 'nicht', 'kein', 'keine', 'keinen', 'keiner', 'keinem', 'keines', 'niemand', 'nichts', 'null',
    'kaum', 'weniger', 'wenige', 'ohne', 'unmöglich', 'unwahrscheinlich', 'eingefroren', 'gestoppt', 'aufgegeben'],
  es: ['es', 'son', 'era', 'eran', 'no', 'nadie', 'nada', 'ningún', 'ninguna', 'ninguno', 'cero', 'menos', 'pocos', 'pocas',
    'imposible', 'improbable', 'congelado', 'detenido', 'cancelado'],
  fr: ['est', 'sont', 'était', 'étaient', 'pas', 'personne', 'rien', 'aucun', 'aucune', 'zéro', 'moins', 'peu', 'impossible',
    'improbable', 'gelé', 'arrêté', 'annulé'],
  ja: ['なし', '無し', 'ない', 'いない', 'ゼロ', '0', '不可能', '未定', '停止'],
}

// A language this table can read: it has a row AND its words are space-delimited. Japanese has a row (a whole role may be one of
// those words) but its phrases are not word-delimited, so a multi-word check cannot run - and must not silently pass.
const SPACED = new Set(['en', 'de', 'es', 'fr'])
const langOf = (lang: string | null | undefined): string => (lang ?? '').trim().toLowerCase().slice(0, 2)

// The language's row, when the table can judge that language's words; null when it cannot (an unlisted language, or one whose
// script is not space-delimited). A null here means "ask the judge", never "fine".
export function roleWordsFor(lang: string | null | undefined): ReadonlySet<string> | null {
  const l = langOf(lang)
  if (!SPACED.has(l) || !Object.hasOwn(NOT_A_ROLE, l)) return null
  return new Set(NOT_A_ROLE[l].map(w => w.toLowerCase()))
}

export const readsLanguage = (lang: string | null | undefined): boolean => roleWordsFor(lang) !== null

// What a judge's reading of one signal is: a company hiring a role (the role, when it named one), or a denial. The plays take these
// readings for a language the table cannot judge (lib/scan/signal-reading.ts reads them with the judge, #2084).
export type SignalReading =
  | { kind: 'hiring'; role: string | null }
  | { kind: 'not_hiring' }
  | { kind: 'other' }   // #2084 B5: judged, but neither hiring nor a denial - a persisted no-play result, never re-asked
