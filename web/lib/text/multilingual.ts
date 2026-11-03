// Script-aware text canonicalization for retrieval and matching (#391). Pure and import-free (no network, no model, no
// database), so every adapter, the signal enrichers and the lookalike scorer share one rule instead of each splitting on
// /[^a-z0-9]/, which erased Arabic, Devanagari and Japanese names to nothing.
//
// Three layers, each with its own trust level:
//   foldText   - lossless-for-matching canonical form: NFKC, lower case, Latin accents folded, Arabic diacritics/tatweel and
//                letter variants folded, Arabic-Indic and Devanagari digits to ASCII. Original text is never replaced: callers
//                keep the source string and fold only the copy they compare.
//   words      - word tokens of ANY script. Scripts written without spaces (Han, kana) are cut at script boundaries: katakana
//                runs and short Han runs are words, long Han runs become overlapping bigrams, hiragana (particles, okurigana)
//                is dropped unless the whole token is hiragana.
//   aliasKey   - a LOSSY cross-script key (romanize, then a consonant skeleton) so a transliterated or code-mixed name
//                ("टाटा मोटर्स", "Tata मोटर्स", "Tata Motors") can be FOUND and compared for similarity. It is a retrieval and
//                similarity aid only: it never confirms an entity, never merges two companies and never passes an identity gate.

const LATIN_MARK = /([a-z])[\u0300-\u036f]+/g
const ARABIC_MARKS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g // harakat, Quranic marks, superscript alef, tatweel
const ARABIC_LETTERS: Record<string, string> = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ی': 'ي', 'ئ': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ک': 'ك' }
const ARABIC_LETTER_RE = new RegExp(`[${Object.keys(ARABIC_LETTERS).join('')}]`, 'g')
const digit = (base: number) => (c: string) => String(c.charCodeAt(0) - base)

export function foldText(s: string): string {
  return s.normalize('NFKC').toLowerCase()
    .normalize('NFD').replace(LATIN_MARK, '$1').normalize('NFC')
    .replace(ARABIC_MARKS, '').replace(ARABIC_LETTER_RE, c => ARABIC_LETTERS[c])
    .replace(/[\u0660-\u0669]/g, digit(0x0660)).replace(/[\u06f0-\u06f9]/g, digit(0x06f0)).replace(/[\u0966-\u096f]/g, digit(0x0966))
}

export type Script = 'latin' | 'arabic' | 'devanagari' | 'japanese' | 'han' | 'hangul' | 'other' | 'none'
const IS = {
  latin: /\p{Script=Latin}/u, arabic: /\p{Script=Arabic}/u, devanagari: /\p{Script=Devanagari}/u,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}\u30fc]/u, han: /\p{Script=Han}/u, hangul: /\p{Script=Hangul}/u,
}
// The dominant script of the letters in a string (kana anywhere makes it Japanese: a Japanese name mixes kanji and kana).
export function scriptOf(s: string): Script {
  const n: Record<string, number> = {}
  for (const ch of s) {
    if (!/\p{L}/u.test(ch)) continue
    const k = IS.latin.test(ch) ? 'latin' : IS.arabic.test(ch) ? 'arabic' : IS.devanagari.test(ch) ? 'devanagari' : IS.kana.test(ch) ? 'japanese' : IS.han.test(ch) ? 'han' : IS.hangul.test(ch) ? 'hangul' : 'other'
    n[k] = (n[k] ?? 0) + 1
  }
  if (n.japanese) return 'japanese'
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0]
  return best ? best[0] as Script : 'none'
}

export const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc]/u
// Cuts one space-delimited token of an unspaced script into words (see header).
export function segmentUnspaced(tok: string): string[] {
  const runs = tok.match(/\p{Script=Han}+|[\p{Script=Katakana}\u30fc]+|\p{Script=Hiragana}+|[^\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\u30fc]+/gu) ?? []
  const allHiragana = /^\p{Script=Hiragana}+$/u.test(tok)
  const out: string[] = []
  for (const r of runs) {
    if (/^\p{Script=Hiragana}+$/u.test(r)) { if (allHiragana && r.length >= 2) out.push(r); continue }
    if (/^\p{Script=Han}+$/u.test(r) && r.length > 4) { for (let i = 0; i + 1 < r.length; i++) out.push(r.slice(i, i + 2)); continue }
    out.push(r)
  }
  return out
}

// Word tokens of any script, folded unless `fold` is false (then only NFKC + lower case: the spelling a search should send). `keep` lists extra characters that stay inside a word (e.g. '+#.-' for c++, node.js,
// seed-stage); leading/trailing ones are trimmed.
export function words(text: string, keep = '', fold = true): string[] {
  const esc = keep.replace(/[\\\]^-]/g, '\\$&')
  const out: string[] = []
  for (const raw of (fold ? foldText(text) : text.normalize('NFKC').toLowerCase()).split(new RegExp(`[^\\p{L}\\p{M}\\p{N}${esc}]+`, 'u'))) {
    const t = raw.replace(/^[.-]+|[.-]+$/g, '') // a sentence's full stop or a dash is not part of the word; c++ and c# keep their marks
    if (!t) continue
    if (UNSPACED.test(t)) out.push(...segmentUnspaced(t))
    else out.push(t)
  }
  return out
}

// Is a token long enough to carry meaning? Latin and other alphabets keep the old rule (4+ characters). Arabic needs 3
// letters (short vowels are not written: دبي is Dubai), Devanagari 2 letters besides its vowel signs (टाटा), Han / kana /
// Hangul 2 characters (東京, トヨタ).
export function meaningful(tok: string, latinMin = 4): boolean {
  const s = scriptOf(tok)
  const letters = [...tok].filter(c => /[\p{L}\p{N}]/u.test(c)).length
  if (s === 'arabic') return letters >= 3
  if (s === 'devanagari' || s === 'japanese' || s === 'han' || s === 'hangul') return letters >= 2
  return tok.length >= latinMin
}

// ---- legal forms -------------------------------------------------------------------------------------------------
// Legal-form words that carry no identity, in the languages #391 covers. Unspaced (Japanese) forms are cut as affixes
// before tokenizing: 株式会社サイボウズ and サイボウズ株式会社 are the same name.
export const LEGAL_AFFIXES = ['株式会社', '有限会社', '合同会社', '合資会社', '合名会社', '(株)', '(有)', '(同)']
export const LEGAL_WORDS = new Set([
  // ar (folded: المحدوده is المحدودة after ة->ه)
  'شركه', 'مؤسسه', 'المحدوده', 'محدوده', 'ذمم', 'شمم', 'شمع',
  // hi
  'प्राइवेट', 'प्रा', 'लिमिटेड', 'लि', 'कंपनी', 'pvt',
  // ja (spaced romanized forms)
  'kabushiki', 'kaisha',
].map(w => foldText(w)))
export const FUND_WORDS = new Set(['基金', 'ファンド', 'キャピタル', 'ベンチャーズ', 'صندوق', 'استثمار', 'फंड', 'कैपिटल', 'वेंचर्स'].map(w => foldText(w)))

export function stripLegalAffixes(folded: string): string {
  let t = folded
  for (const a of LEGAL_AFFIXES) t = t.split(foldText(a)).join(' ')
  return t
}

// Company-name tokens in any script, legal forms (the caller's own Latin set plus LEGAL_WORDS) removed. Japanese names stay
// whole words here (no bigrams): identity compares names, not fragments.
export function companyNameTokens(name: string, suffixes: Set<string>): string[] {
  const t = stripLegalAffixes(foldText(name))
  const out: string[] = []
  for (const w of t.split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (!w || suffixes.has(w) || LEGAL_WORDS.has(w)) continue
    if (UNSPACED.test(w)) { for (const r of w.match(/\p{Script=Han}+|[\p{Script=Katakana}\u30fc]+|\p{Script=Hiragana}+|[^\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\u30fc]+/gu) ?? []) out.push(r) }
    else out.push(w)
  }
  return out
}

// ---- romanization (lossy, for aliases only) -----------------------------------------------------------------------
const DEV_CONS: Record<string, string> = { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n', 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l' }
const DEV_NUKTA: Record<string, string> = { 'क': 'q', 'ज': 'z', 'फ': 'f', 'ड': 'r', 'ढ': 'rh', 'ख': 'kh', 'ग': 'gh' }
const DEV_VOWEL: Record<string, string> = { 'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o' }
const DEV_MATRA: Record<string, string> = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' }
function romanizeDevanagari(s: string): string {
  const cs = [...s]; let out = ''
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]
    if (DEV_CONS[c]) {
      let base = DEV_CONS[c]
      if (cs[i + 1] === '\u093c') { base = DEV_NUKTA[c] ?? base; i++ }
      const next = cs[i + 1]
      if (next === '\u094d') { out += base; i++ } // virama: no vowel
      else if (next && DEV_MATRA[next]) { out += base + DEV_MATRA[next]; i++ }
      else out += base + (i + 1 < cs.length ? 'a' : '') // inherent a, dropped at word end
    } else if (DEV_VOWEL[c]) out += DEV_VOWEL[c]
    else if (c === '\u0902' || c === '\u0901') out += 'n' // anusvara, chandrabindu
    else if (c === '\u0903') out += 'h'
    else if (/[a-z0-9]/.test(c)) out += c
  }
  return out
}
const AR: Record<string, string> = { 'ا': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': '', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'و': 'w', 'ي': 'y', 'ء': '', 'پ': 'p', 'چ': 'ch', 'گ': 'g' }
function romanizeArabic(s: string): string {
  const w = s.startsWith('ال') && [...s].length > 3 ? s.slice(2) : s // the definite article is its own word in Latin ("Al Rajhi")
  return [...w].map(c => AR[c] ?? (/[a-z0-9]/.test(c) ? c : '')).join('')
}
const KANA: Record<string, string> = {}
{
  const rows = 'a i u e o|ka ki ku ke ko|sa shi su se so|ta chi tsu te to|na ni nu ne no|ha hi fu he ho|ma mi mu me mo|ya _ yu _ yo|ra ri ru re ro|wa _ _ _ wo'.split('|')
  const kata = 'アイウエオ|カキクケコ|サシスセソ|タチツテト|ナニヌネノ|ハヒフヘホ|マミムメモ|ヤ_ユ_ヨ|ラリルレロ|ワ___ヲ'.split('|')
  rows.forEach((r, i) => r.split(' ').forEach((rom, j) => { const k = kata[i][j]; if (k && k !== '_' && rom !== '_') KANA[k] = rom }))
  Object.assign(KANA, { 'ガ': 'ga', 'ギ': 'gi', 'グ': 'gu', 'ゲ': 'ge', 'ゴ': 'go', 'ザ': 'za', 'ジ': 'ji', 'ズ': 'zu', 'ゼ': 'ze', 'ゾ': 'zo', 'ダ': 'da', 'ヂ': 'ji', 'ヅ': 'zu', 'デ': 'de', 'ド': 'do', 'バ': 'ba', 'ビ': 'bi', 'ブ': 'bu', 'ベ': 'be', 'ボ': 'bo', 'パ': 'pa', 'ピ': 'pi', 'プ': 'pu', 'ペ': 'pe', 'ポ': 'po', 'ン': 'n', 'ヴ': 'vu', 'ァ': 'a', 'ィ': 'i', 'ゥ': 'u', 'ェ': 'e', 'ォ': 'o' })
}
const SMALL_Y: Record<string, string> = { 'ャ': 'a', 'ュ': 'u', 'ョ': 'o' }
function romanizeKana(s: string): string {
  // hiragana -> katakana first (same table)
  const k = s.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
  const cs = [...k]; let out = ''
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]
    if (c === 'ッ' || c === 'ー') continue // gemination / long vowel: dropped (skeleton collapses doubles anyway)
    const r = KANA[c]
    if (!r) { if (/[a-z0-9]/.test(c)) out += c; continue }
    if (SMALL_Y[cs[i + 1]]) { out += r.replace(/i$/, '').replace(/^(sh|ch|j)$/, '$1') + (/^(sh|ch|j)/.test(r) ? '' : 'y') + SMALL_Y[cs[i + 1]]; i++ }
    else if (/^[ァィゥェォ]$/.test(cs[i + 1] ?? '') && r.length > 1) { out += r.slice(0, -1) + KANA[cs[i + 1]]; i++ }
    else out += r
  }
  return out
}

// A Latin rendering of one folded word. Han (no reading without a dictionary) and unknown scripts give ''.
export function romanize(word: string): string {
  const s = scriptOf(word)
  if (s === 'latin' || s === 'none') return word.replace(/[^a-z0-9]/g, '')
  if (s === 'devanagari') return romanizeDevanagari(word)
  if (s === 'arabic') return romanizeArabic(word)
  if (s === 'japanese') return romanizeKana(word)
  return ''
}

// Consonant skeleton of a Latin string: doubled letters collapsed, digraphs folded, c read as k or s, vowels and the
// semi-vowels y/w dropped ("Tata" stays tt: consonants on either side of a vowel are not merged). Lossy by design (Hindi and Arabic rarely write short vowels; transliterations disagree on them).
export function skeleton(latin: string): string {
  return latin.toLowerCase().replace(/[^a-z]/g, '')
    .replace(/(.)\1+/g, '$1')
    .replace(/chh|ch/g, 'c').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/sh/g, 's').replace(/th/g, 't').replace(/dh/g, 'd').replace(/ph/g, 'f').replace(/bh/g, 'b').replace(/jh/g, 'j')
    .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k').replace(/v/g, 'w').replace(/x/g, 'ks').replace(/ts/g, 's')
    .replace(/[aeiouyw]/g, '')
}

const ARTICLES = new Set(['al', 'el'])
// Cross-script alias key of a company name: one skeleton per name token, legal forms and the Arabic article removed. null
// when the name has a Han-only token (no reading) or the key is too short (under 3 consonants) to mean anything.
export function aliasKey(name: string, suffixes: Set<string> = new Set()): string | null {
  const parts: string[] = []
  for (const t of companyNameTokens(name, suffixes)) {
    if (ARTICLES.has(t)) continue
    const s = scriptOf(t)
    if (s === 'han' || s === 'hangul' || s === 'other') return null
    const sk = skeleton(romanize(t))
    if (sk) parts.push(sk)
  }
  const key = parts.join(' ')
  return key.replace(/ /g, '').length >= 3 ? key : null
}

// The same name written in different scripts (or code-mixed): equal alias keys AND the two names do not share one script
// already (same-script names are compared exactly by the caller, never through the lossy key). Retrieval/similarity only.
export function transliteratedAlias(a: string, b: string, suffixes: Set<string> = new Set()): boolean {
  const ka = aliasKey(a, suffixes), kb = aliasKey(b, suffixes)
  if (!ka || !kb || ka !== kb || foldText(a) === foldText(b)) return false
  const sa = scriptsIn(a), sb = scriptsIn(b)
  return sa.size > 1 || sb.size > 1 || [...sa].some(x => !sb.has(x))
}
const scriptsIn = (s: string): Set<Script> => new Set([...s].filter(c => /\p{L}/u.test(c)).map(scriptOf))

// ---- stopwords ----------------------------------------------------------------------------------------------------
// Request filler in the languages #391 covers (folded at build time so alef / yeh variants match).
export const MULTI_STOP = new Set([
  // ar
  'في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'التي', 'الذي', 'الذين', 'هذا', 'هذه', 'او', 'أو', 'ثم', 'شركات', 'شركة', 'الشركات', 'ابحث', 'أبحث', 'نبحث', 'تبحث', 'عن', 'لديها', 'حديثا', 'مؤخرا',
  // hi
  'में', 'के', 'की', 'का', 'को', 'से', 'और', 'या', 'लिए', 'है', 'हैं', 'जो', 'ने', 'पर', 'कंपनी', 'कंपनियां', 'कंपनियाँ', 'कंपनियों', 'ढूंढो', 'ढूंढें', 'खोजें', 'हाल', 'ही',
  // ja
  '会社', '企業', 'する', 'している', 'いる', 'ある', 'こと', 'もの', 'ため', '探す', '探して', '最近',
].map(w => foldText(w)))
