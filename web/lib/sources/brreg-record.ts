// The Norway register's own API record for one entity (#763), as a citable, re-readable page.
// https://data.brreg.no/enhetsregisteret/api/{enheter|underenheter}/{organisasjonsnummer} is the official, keyless, open record (NLOD 2.0). It states the
// registration date (registreringsdatoEnhetsregisteret) that the public entity page on virksomhet.brreg.no does not show in its text. The adapter cites this URL and the
// verifier's page fetcher re-reads it; BOTH render the parsed record with the ONE function below, so the quote the adapter cuts is exactly the text the verifier checks.
export const BRREG_RECORD_URL = /^https:\/\/data\.brreg\.no\/enhetsregisteret\/api\/(enheter|underenheter)\/(\d{9})$/
export function brregRecordRef(url: string): { kind: 'enheter' | 'underenheter'; id: string } | null {
  const m = BRREG_RECORD_URL.exec(url)
  return m ? { kind: m[1] as 'enheter' | 'underenheter', id: m[2] } : null
}
export const brregRecordUrl = (kind: 'enheter' | 'underenheter', id: string) => `https://data.brreg.no/enhetsregisteret/api/${kind}/${id}`

const ISO = /^\d{4}-\d{2}-\d{2}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
const at = (v: unknown, k: string) => (isObj(v) ? str(v[k]) : '')

// The record's text, or null when the body is not the record of exactly this entity (wrong shape, another organisation number, no usable registration date).
// One sentence names the entity, its organisation number and the day the register states for its registration, so the date sits next to the name it belongs to.
export function renderBrregRecord(body: unknown, expectedId: string): { text: string; title: string; registered: string } | null {
  if (!isObj(body) || str(body.organisasjonsnummer) !== expectedId) return null
  const navn = str(body.navn), registered = str(body.registreringsdatoEnhetsregisteret)
  if (!navn || !ISO.test(registered) || Number.isNaN(Date.parse(registered))) return null
  const form = at(body.organisasjonsform, 'beskrivelse'), activity = at(body.naeringskode1, 'beskrivelse')
  const addr = isObj(body.forretningsadresse) ? body.forretningsadresse : isObj(body.beliggenhetsadresse) ? body.beliggenhetsadresse : null
  const place = at(addr, 'kommune')
  const facts = [form, activity, place].filter(Boolean).join(', ')
  const text = `${navn} (organisasjonsnummer ${expectedId})${facts ? `, ${facts},` : ''} was registered in Enhetsregisteret on ${registered}.`
  return { text, title: `Enhetsregisteret: ${navn}`, registered }
}
// The quote cut from that text: the whole sentence, within the 20-300 character evidence limit.
export const brregRecordQuote = (text: string): string | null => (text.length >= 20 && text.length <= 300 ? text : null)
