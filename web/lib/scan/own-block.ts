// A page that lists several companies ("best clinics in London", a funding round-up) gives each company its own place. The place a candidate is judged
// on must come from ITS block: the sentences that name it (plus an own-address sentence that continues them), never another company's address on the
// same page. A page whose title names the company is about that company alone, so its whole text counts. A company the page never names in a sentence
// has no block, and no block is "unconfirmed", never a mismatch it did not earn.
import { companyKey, hasPhrase, norm } from './evidence.ts'
import { placeAgreement, type PlaceVerdict } from './place-agreement.ts'

// A sentence ends at . ! ? followed by a capital, a digit OR a lowercase start - a lowercase company ("acme is headquartered in Manchester") begins a new sentence too.
// A lowercase piece that only carries on the previous one (starts with an auxiliary / connective: "is based in ...", "and ...", "which ...") is joined back, and so is
// a piece after an abbreviation ("Brightloop Ltd. is ...", "U.K. and ...").
const ABBREV = /(?:\b(?:inc|ltd|llc|plc|corp|co|st|ave|rd|blvd|no|vs|etc|mr|mrs|ms|dr|jr|sr|e\.g|i\.e|u\.k|u\.s|approx)|\b[a-z])\.$/i
const LOWER_CONTINUES = /^(?:is|are|was|were|has|have|had|and|or|but|which|who|whose|that|with|in|at|on|of|to|for|from|by|as|also|now|then|still|it|its|their|they|we|our|located|based|offices?|hq|headquartered|including|while|where|when)\b/
const sentences = (text: string): string[] => {
  const out: string[] = []
  for (const piece of text.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean)) {
    const prev = out[out.length - 1]
    const startsLower = /^[a-z]/.test(piece)
    if (prev !== undefined && (ABBREV.test(prev) || (startsLower && LOWER_CONTINUES.test(piece)))) out[out.length - 1] = `${prev} ${piece}`
    else out.push(piece)
  }
  return out
}
// A sentence that carries on about the company just named ("Our clinic is at ...", "Located at ...", "Visit us at ...").
const CONTINUES = /^(?:our|we|its|located|based|address|visit|find|come|headquarters|hq|offices?|the (?:office|clinic|studio|practice|team)|they|it)\b/i
// ... unless the sentence is about someone ELSE ("Its competitor Acme is headquartered in Manchester", "We compete with Acme"): it ends the block.
const ABOUT_ANOTHER = /\b(?:competitors?|rivals?|peers?|partners?|customers?|clients?|suppliers?|vendors?|investors?|backers?|acquir\w+|subsidiar\w+|parent|sister|former|another|other|neighbou?r\w*|affiliates?|compet\w+|against|versus|vs\.?|than)\b/i
// A title that names the company is about it alone only when it does not look like a list or a pairing ("Seed round-up: Brightloop and Acme").
const MULTI_TITLE = /,|;|\band\b|&|\bvs\.?\b|\bversus\b|\bplus\b|\+|\b(?:round-?ups?|roundup|list|best|top|\d+\s+\w+)\b|\bwho\b|\bthis\s+week\b/i

export function ownBlock(text: string, company: string, title = '', excerpt = ''): string | null {
  const key = companyKey(company)
  if (key.length < 2) return null
  if (hasPhrase(norm(title), key) && !MULTI_TITLE.test(title)) return text // the page is about this company alone
  const ex = norm(excerpt).slice(0, 50)
  const ss = sentences(text), out: string[] = []
  ss.forEach((s, i) => {
    const n = norm(s)
    const own = hasPhrase(n, key) || (ex.length >= 20 && n.includes(ex))
    const follows = i > 0 && CONTINUES.test(s) && !ABOUT_ANOTHER.test(s) && (hasPhrase(norm(ss[i - 1]), key) || out.includes(ss[i - 1]))
    if (own || follows) out.push(s)
  })
  return out.length ? out.join(' ') : null
}

// Place agreement on the candidate's own block only. `no_geography` when the request names no place.
export function ownPlaceAgreement(page: { title: string; text: string }, where: string[], company: string, excerpt = ''): PlaceVerdict {
  const probe = placeAgreement('', where, company)
  if (probe === 'no_geography') return probe
  const block = ownBlock(page.text, company, page.title, excerpt)
  if (block === null) return 'unconfirmed'
  return placeAgreement(`${page.title} ${block}`, where, company)
}
