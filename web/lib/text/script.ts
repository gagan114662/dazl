// Script-aware text handling (#391): canonicalisation, tokenisation, entity keys, market expansion and translation links that work for Arabic, Hindi (Devanagari),
// Japanese, Chinese, Korean, Cyrillic, Greek, Thai, Hebrew and Latin - not just [a-z0-9]. Rules: the ORIGINAL text is always kept beside any translation or
// transliteration; same-name entities in different countries stay separate (the key carries domain, or country when there is no domain); a token is never made
// shorter or "cleaned" in a way that merges different words; nothing here calls a model or the network.
export type Script = 'latin' | 'arabic' | 'devanagari' | 'han' | 'kana' | 'hangul' | 'cyrillic' | 'greek' | 'thai' | 'hebrew' | 'other'
const RANGES: [Script, RegExp][] = [['arabic', /\p{Script=Arabic}/u], ['devanagari', /\p{Script=Devanagari}/u], ['han', /\p{Script=Han}/u], ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ['hangul', /\p{Script=Hangul}/u], ['cyrillic', /\p{Script=Cyrillic}/u], ['greek', /\p{Script=Greek}/u], ['thai', /\p{Script=Thai}/u], ['hebrew', /\p{Script=Hebrew}/u], ['latin', /\p{Script=Latin}/u]]
export function scriptOfChar(ch: string): Script { for (const [s, re] of RANGES) if (re.test(ch)) return s; return 'other' }
// Dominant script of a string (counts letters only); Japanese text mixes Han and Kana, and any kana makes the text Japanese.
export function scriptOf(text: string): Script {
  const n = new Map<Script, number>()
  for (const ch of text) if (/\p{L}/u.test(ch)) { const s = scriptOfChar(ch); n.set(s, (n.get(s) ?? 0) + 1) }
  if ((n.get('kana') ?? 0) > 0) return 'kana'
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other'
}

// Canonical comparison form: NFKC, case-folded, Latin/Greek/Cyrillic diacritics removed (so "Zürich" = "Zurich"), Arabic marks and tatweel removed with alef/yeh variants unified,
// Devanagari and other combining vowel signs KEPT (stripping them would merge different Hindi words).
export function fold(text: string): string {
  let s = text.normalize('NFKC').toLowerCase()
  s = s.replace(/[ً-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
  s = s.normalize('NFD').replace(/(\p{Script=Latin}|\p{Script=Greek}|\p{Script=Cyrillic})\p{Mn}+/gu, '$1').normalize('NFC')
  return s.replace(/\s+/g, ' ').trim()
}

const SEG: Partial<Record<Script, string>> = { han: 'zh', kana: 'ja', thai: 'th' }
function words(text: string, script: Script): string[] {
  const lang = SEG[script]
  if (lang && typeof Intl !== 'undefined' && 'Segmenter' in Intl) return [...new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)].filter(s => s.isWordLike).map(s => s.segment)
  return text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean)
}
// Keep + # . - inside a Latin word (c++, c#, node.js, e-commerce) as the original keywordsFor did.
const LATIN_WORD = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}+#.-]*/gu
export function tokenize(text: string, joiners = false): string[] {
  const f = fold(text), out: string[] = []
  for (const chunk of f.split(/\s+/)) {
    if (!chunk) continue
    const sc = scriptOf(chunk)
    if (sc === 'latin' || sc === 'cyrillic' || sc === 'greek' || sc === 'arabic' || sc === 'devanagari' || sc === 'hangul' || sc === 'hebrew') out.push(...(chunk.match(sc === 'latin' && joiners ? LATIN_WORD : /[\p{L}\p{M}\p{N}]+/gu) ?? []).map(w => w.replace(/^[.+#-]+|[.-]+$/g, '')).filter(Boolean))
    else out.push(...words(chunk, sc))
  }
  return out
}
// A meaningful minimum: 4 letters in alphabetic scripts, 2 characters in logographic / syllabic ones (a 2-character Han or kana word is a normal word).
const minLen = (t: string) => { const s = scriptOf(t); return s === 'han' || s === 'kana' || s === 'hangul' || s === 'thai' ? 2 : s === 'latin' ? 4 : 3 }
const STOP = new Set(['looking', 'find', 'companies', 'company', 'people', 'who', 'that', 'with', 'from', 'have', 'just', 'recently', 'their', 'they', 'the', 'and', 'for', 'في', 'من', 'على', 'और', 'के', 'में', 'を', 'の', 'に', 'は', 'и', 'в', 'на', '的', '在', '和'])
export function keywords(query: string, max = 6): string[] { return [...new Set(tokenize(query, true).filter(w => w.length >= 1 && [...w].length >= minLen(w) && !STOP.has(w)))].slice(0, max) }

// Legal-form words stripped from company names, per language, so "Acme Ltd" = "Acme" and "トヨタ株式会社" = "トヨタ".
const LEGAL = ['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'gmbh', 'sarl', 'sas', 'plc', 'lp', 'llp', 'sa', 'ag', 'bv', 'nv', 'pty', 'pvt', 'private', 'limited', 'group', 'ooo', 'зао', 'оао', 'ооо', 'شركة', 'ذ.م.م', 'مؤسسة', 'ليمتد', 'लिमिटेड', 'प्राइवेट', 'प्रा', 'कंपनी', '株式会社', '有限会社', '合同会社', '有限公司', '股份有限公司', '公司', '集团', '주식회사', '유한회사']
const LEGAL_SET = new Set(LEGAL.map(fold)), LEGAL_AFFIX = LEGAL.filter(l => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(l)).sort((a, b) => b.length - a.length)
export function nameTokens(name: string): string[] {
  let f = fold(name)
  for (const a of LEGAL_AFFIX) f = f.split(a).join(' ')         // CJK legal forms are attached to the name without spaces
  return tokenize(f).filter(t => ([...t].length > 1 || scriptOf(t) === 'han') && !LEGAL_SET.has(t))
}

export interface Named { name: string; domain?: string | null; country?: string | null }
const host = (d?: string | null) => (d ?? '').toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0]
// Entity identity key. A domain identifies; otherwise the folded name tokens PLUS country, so the same name in two countries is two entities (never merged by name alone).
export function entityKey(e: Named): string {
  const d = host(e.domain); if (d.includes('.')) return `d:${d}`
  const t = nameTokens(e.name).join(' ')
  return `n:${t}${e.country ? `|${e.country.toUpperCase()}` : '|?'}`
}
export interface NameForms { original: string; translated?: string | null; transliterated?: string | null; lang?: string | null }
// Names for one entity in several forms. The ORIGINAL is always first and never replaced; matching may use any form but each form keeps its provenance.
export function nameForms(original: string, extra: { translated?: string | null; transliterated?: string | null } = {}): NameForms { return { original: original.trim(), translated: extra.translated?.trim() || null, transliterated: extra.transliterated?.trim() || null, lang: scriptOf(original) } }
export function sameName(a: NameForms, b: NameForms): { same: boolean; via: 'original' | 'translated' | 'transliterated' | null } {
  const key = (s?: string | null) => (s ? nameTokens(s).join(' ') : '')
  const ak = { original: key(a.original), translated: key(a.translated), transliterated: key(a.transliterated) }, bk = { original: key(b.original), translated: key(b.translated), transliterated: key(b.transliterated) }
  if (ak.original && ak.original === bk.original) return { same: true, via: 'original' }
  for (const k of ['translated', 'transliterated'] as const) for (const kb of ['original', 'translated', 'transliterated'] as const) if (ak[k] && ak[k] === bk[kb]) return { same: true, via: k }
  for (const k of ['translated', 'transliterated'] as const) if (bk[k] && bk[k] === ak.original) return { same: true, via: k }
  return { same: false, via: null }
}

// A translated quote is a label on the original evidence, never evidence by itself: it carries the original text and URL, and only the original is checked against the page.
export interface TranslatedQuote { original: string; translated: string; lang: string; source_url: string }
export function linkQuote(original: string, translated: string, source_url: string): TranslatedQuote { return { original: original.trim(), translated: translated.trim(), lang: scriptOf(original), source_url } }
export const quoteOnPage = (q: TranslatedQuote, pageText: string) => fold(pageText).replace(/\s+/g, ' ').includes(fold(q.original).replace(/\s+/g, ' '))

// Markets: a geography with several countries / languages becomes explicit, bounded tasks. Nothing is silently dropped; an unrecognised place is its own task, flagged.
const MARKETS: Record<string, { country: string; langs: string[] }> = {
  'united states': { country: 'US', langs: ['en', 'es'] }, usa: { country: 'US', langs: ['en', 'es'] }, 'united kingdom': { country: 'GB', langs: ['en'] }, uk: { country: 'GB', langs: ['en'] },
  germany: { country: 'DE', langs: ['de'] }, france: { country: 'FR', langs: ['fr'] }, spain: { country: 'ES', langs: ['es'] }, italy: { country: 'IT', langs: ['it'] }, brazil: { country: 'BR', langs: ['pt'] },
  japan: { country: 'JP', langs: ['ja'] }, china: { country: 'CN', langs: ['zh'] }, taiwan: { country: 'TW', langs: ['zh'] }, 'south korea': { country: 'KR', langs: ['ko'] }, korea: { country: 'KR', langs: ['ko'] },
  india: { country: 'IN', langs: ['en', 'hi'] }, 'saudi arabia': { country: 'SA', langs: ['ar', 'en'] }, uae: { country: 'AE', langs: ['ar', 'en'] }, 'united arab emirates': { country: 'AE', langs: ['ar', 'en'] }, egypt: { country: 'EG', langs: ['ar'] },
  israel: { country: 'IL', langs: ['he', 'en'] }, russia: { country: 'RU', langs: ['ru'] }, ukraine: { country: 'UA', langs: ['uk', 'ru'] }, thailand: { country: 'TH', langs: ['th'] }, canada: { country: 'CA', langs: ['en', 'fr'] }, mexico: { country: 'MX', langs: ['es'] },
}
export interface MarketTask { place: string; country: string | null; lang: string; resolved: boolean }
export const MAX_MARKETS = 6, MAX_LANGS = 2
export function expandMarkets(where: string[]): { tasks: MarketTask[]; skipped: string[] } {
  const tasks: MarketTask[] = [], skipped: string[] = []
  for (const w of where.map(x => x.trim()).filter(Boolean)) {
    if (new Set(tasks.map(t => t.place)).size >= MAX_MARKETS) { skipped.push(w); continue }      // bounded, and the overflow is REPORTED
    const m = MARKETS[fold(w)]
    if (!m) { tasks.push({ place: w, country: null, lang: scriptOf(w) === 'latin' ? 'en' : scriptOf(w), resolved: false }); continue }
    for (const lang of m.langs.slice(0, MAX_LANGS)) tasks.push({ place: w, country: m.country, lang, resolved: true })
  }
  return { tasks, skipped }
}
