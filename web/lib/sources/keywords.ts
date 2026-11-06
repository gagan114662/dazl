// Request keywords for the public-source adapters, and the matching rule they use on source text (#391).
import { MULTI_STOP, aliasKey, foldText, meaningful, romanize, scriptOf, skeleton, stripLegalAffixes, words } from '../text/multilingual.ts'

const STOP = new Set(['looking', 'find', 'companies', 'company', 'people', 'who', 'that', 'with', 'from', 'have', 'just', 'recently', 'their', 'they', 'in', 'for', 'and', 'the'])
// Keywords in the request's OWN script and spelling first (#391: Arabic, Hindi and Japanese requests used to give no
// keywords at all, so every adapter searched for nothing), then a Latin rendering of Devanagari and katakana words (brand and
// loan words are often written that way: टाटा मोटर्स, ソフトバンク), so English-indexed sources (GitHub, YouTube, an English feed)
// can still find a transliterated or code-mixed name. Arabic is not romanized for search: without its unwritten vowels the
// rendering is not a word anyone searches. Originals are never replaced by the alias.
const romanizable = (w: string) => /[\p{Script=Devanagari}\p{Script=Katakana}]/u.test(w) && !/\p{Script=Han}/u.test(w)
export function keywordsFor(query: string): string[] {
  const own = [...new Set(words(stripLegalAffixes(query), '+#.-', false).filter(w => meaningful(w) && !STOP.has(w) && !MULTI_STOP.has(foldText(w))))]
  const alias = own.filter(w => romanizable(w) && aliasKey(w)).map(romanize).filter(r => r.length >= 4 && !STOP.has(r) && !own.includes(r))
  const ownCap = alias.length ? 4 : 6
  return [...new Set([...own.slice(0, ownCap), ...alias])].slice(0, 6)
}
// Does a piece of source text mention a keyword? Both sides folded (accents, Arabic diacritics and letter variants, digit
// forms). Across scripts a word also matches by its consonant skeleton (3+ letters): मोटर्स in the keywords matches "Motors"
// in an English title, and "motors" matches मोटर्स. Same-script words are never matched through the lossy skeleton.
export function mentionsKeyword(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true
  const hay = foldText(text)
  if (keywords.some(k => hay.includes(foldText(k)))) return true
  const textWords = words(text).map(w => ({ latin: scriptOf(w) === 'latin', sk: skeleton(romanize(w)) })).filter(w => w.sk.length >= 3)
  return keywords.some(k => {
    const latin = scriptOf(k) === 'latin', sk = skeleton(romanize(foldText(k)))
    return sk.length >= 3 && textWords.some(w => w.latin !== latin && w.sk === sk)
  })
}
