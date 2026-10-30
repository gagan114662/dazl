// #349: text quoted inside a sentence ("...says you sell <X>, but it started with <Y>. dazl will...") ends where the
// sentence goes on, so it drops its own closing punctuation: one or more . ! ? or an ellipsis (also "..."), with any
// trailing space, including when a closing quote or bracket follows it (the closer stays). Without this an offer saved as
// "...in New York City." renders "City.. dazl". `next` is the punctuation the sentence puts after it: before its own "."
// an abbreviation's period merges into the sentence's ("in the U.S."); before "," ";" or ":" an abbreviation keeps its
// period ("in the U.S., but"). Text that is nothing but punctuation is shown as it is, never as an empty quote.
// Applied to the shown text only; the value chosen and stored is unchanged.
const ABBREVIATION = /(?:^|[\s(])(?:(?:[A-Za-z]\.){2,}|(?:etc|Inc|Ltd|Co|Corp|Jr|Sr|St|vs|approx)\.)(["'”’)\]]*)$/
export function inSentence(text: string, next: '.' | ',' | ';' | ':' = '.'): string {
  const t = text.replace(/\s+$/, '')
  const out = next !== '.' && ABBREVIATION.test(t) ? t : t.replace(/[.!?…]+(["'”’)\]]*)$/, '$1')
  return /[\p{L}\p{N}]/u.test(out) ? out : t
}
