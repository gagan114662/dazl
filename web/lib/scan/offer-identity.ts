// One offer-identity contract for construction, persistence, the reviewed draft, retrieval titles and decision reuse (#874). Pure: no imports, no I/O.
//
// An offer is identified by its NAME. Its id is a stable label derived from that name; the id is never trusted on its own to say whose a saved answer is.
//  - storedOfferName(): exactly what persistence keeps of a name (control characters -> space, whitespace collapsed, trimmed, capped at STORED_NAME).
//  - nameKey(): what makes two stored names the SAME offer (case/width folded; accents, scripts and punctuation kept: they distinguish offers).
//  - A saved row that carries only an id (seller_decisions.offer_id) is rebound to a current offer by rebindOfferId(): unambiguously, or HELD.
export const ID_MAX = 40
export const STORED_NAME = 60
const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
export const storedOfferName = (name: unknown): string => (typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, STORED_NAME) : '')
const fold = (s: string): string => s.normalize('NFKC').toLowerCase()
// Identity of a name as persistence will return it: canonicalize like storage FIRST, then cap, then fold.
export const storedKey = (name: string): string => fold(storedOfferName(name))
// Identity of a name as read from a page (up to 120 characters): canonicalize, fold; not capped at the stored width.
export const offerKey = (name: string): string => fold(name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120))
function digest(s: string): string {   // cyrb53, 12 hex digits; pure JS so the core stays runtime-agnostic
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677) }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0').slice(-12)
}
// A readable slug prefix, a double hyphen (which no plain slug and no legacy positional suffix can contain) and a digest of the full normalized name.
export const hashedId = (slug: string, key: string): string => `${slug.slice(0, 25).replace(/-+$/g, '') || 'offer'}--${digest(key)}`
const plain = (name: string): string => slugOf(name.slice(0, 120)) || 'offer'
// The id of a name on its own: plain when it fits, hashed when it cannot. (A short name that collides with a different name in the same read is hashed by offerIds().)
export function offerId(name: string): string { const s = plain(name); return s.length <= ID_MAX ? s : hashedId(s, offerKey(name)) }
// Ids for a whole read, independent of listing order. `ambiguous[i]`: the SAME name is listed more than once, so those offers cannot be told apart.
export function offerIds(names: string[]): { ids: string[]; ambiguous: boolean[] } {
  const keys = names.map(offerKey), slugs = names.map(plain)
  const keysBySlug = new Map<string, Set<string>>()
  slugs.forEach((sl, i) => { const k = keysBySlug.get(sl) ?? new Set<string>(); k.add(keys[i]); keysBySlug.set(sl, k) })
  const seenKey = new Map<string, number>()
  const ids = names.map((_, i) => {
    const n = (seenKey.get(keys[i]) ?? 0) + 1; seenKey.set(keys[i], n)
    if (slugs[i].length <= ID_MAX && (keysBySlug.get(slugs[i])?.size ?? 0) <= 1 && n === 1) return slugs[i]
    return hashedId(slugs[i], n === 1 ? keys[i] : `${keys[i]}#${n}`)
  })
  return { ids, ambiguous: keys.map(k => keys.filter(x => x === k).length > 1) }
}
export const legacyBase = (name: string): string => slugOf(name).slice(0, ID_MAX).replace(/-+$/g, '') || 'offer'
// Every id this offer's NAME has ever been (or could now be) saved under: the stored id, the plain slug when it fits, the old truncated slug, the hashed form.
export function aliasIds(o: { id: string; name: string }): string[] {
  const s = plain(o.name), set = new Set<string>([o.id, legacyBase(o.name)])
  if (s.length <= ID_MAX) set.add(s)
  if (storedOfferName(o.name).length < STORED_NAME) set.add(hashedId(s, storedKey(o.name)))   // recomputable from the stored name only when nothing was cut
  return [...set]
}
type Named = { id: string; name: string }
// The one play-name -> offer selection used by the reviewed draft, retrieval titles and decision reuse. Tier 1: the same STORED name. Tier 2 (older plays): the loose comparison that
// also folds accents and punctuation, applied to the stored width. More than one candidate, or a stored id shared by two offers, selects nothing.
export function selectOffer(offers: Named[], play: string, loose: (a: string, b: string) => boolean): string | null {
  const unique = (o: Named) => offers.filter(x => x.id === o.id).length === 1
  const strict = offers.filter(o => storedKey(o.name) === storedKey(play))
  if (strict.length) return strict.length === 1 && unique(strict[0]) ? strict[0].id : null
  const cut = storedOfferName(play), l = offers.filter(o => loose(o.name, play) || loose(o.name, cut))
  return l.length === 1 && unique(l[0]) ? l[0].id : null
}
export type Rebind = { offer: string } | { held: string[] } | null
// A saved row that only carries an id. Rebound to the ONE current offer that id can mean; HELD (all candidates named) when it could mean several or is an old positional id that
// storage collapsed; null when it names no current offer (the offer was removed): that decision is not carried.
export function rebindOfferId(offers: Named[], x: string): Rebind {
  const hit = offers.filter(o => aliasIds(o).includes(x))
  if (hit.length === 1) return { offer: hit[0].id }
  if (hit.length > 1) return { held: hit.map(o => o.id) }
  const m = /^(.*[a-z0-9])-(\d+)$/.exec(x)   // an old positional id: '<legacy slug>-N' says which COPY of a colliding slug, which the id no longer carries
  if (m) { const near = offers.filter(o => legacyBase(o.name) === m[1]); if (near.length) return { held: near.map(o => o.id) } }
  return null
}
