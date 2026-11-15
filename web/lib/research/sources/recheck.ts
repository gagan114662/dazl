// MISSION v2 part E: the registry verify path's re-read (asked for by A and D, board/E.md). A registry Candidate cites the city's own open-data
// record for ONE permit / licence (socrata-permits.ts, opendatasoft-licences.ts: lib/research/sources/record-page.ts names exactly those URLs).
// At verify time the record is read again, by its id, through the guarded getter (https, public IPs, no redirects, 1 MB, 10 s), and its own
// fields come back: the business, the issue day, what it is for, and the citation a proof carries ("the city's open-data record, permit N,
// issued <date>"). The event is proved by the record, never by the captcha-protected human page. Fails closed: whatever cannot be read says why.
import type { SafeGet } from '../../sources/types.ts'
import { looksLikeHtml } from '../../sources/types.ts'
import { registryRecordFacts, registryRecordRef, type RegistryRecordFacts } from './record-page.ts'

export type RegistryRecheck = ({ ok: true; recordUrl: string; recordId: string } & RegistryRecordFacts) | { ok: false; why: string }

const noRows = (body: unknown): boolean => (Array.isArray(body) ? body.length === 0 : !!body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results) && (body as { results: unknown[] }).results.length === 0)

// `candidate` is a Candidate (its url) or the record URL itself. Any URL that is not exactly one record of a dataset E's sources cite is refused
// before a request is made.
export async function recheckRegistryRecord(candidate: string | { url: string }, http: SafeGet): Promise<RegistryRecheck> {
  const url = typeof candidate === 'string' ? candidate : candidate.url
  const ref = registryRecordRef(url)
  if (!ref) return { ok: false, why: 'not_a_registry_record' }
  const res = await http(url, { accept: 'application/json' }).catch(() => null)
  if (!res) return { ok: false, why: 'unreachable' }
  if (res.status !== 200) return { ok: false, why: res.status === 429 ? 'throttled' : `http_${res.status}` }
  if (res.truncated) return { ok: false, why: 'oversize' }
  if (looksLikeHtml(res.body)) return { ok: false, why: 'not_json' }
  let body: unknown
  try { body = JSON.parse(res.body) } catch { return { ok: false, why: 'not_json' } }
  const facts = registryRecordFacts(body, ref)
  if (!facts) return { ok: false, why: noRows(body) ? 'record_not_found' : 'record_unreadable' }
  return { ok: true, recordUrl: url, recordId: ref.id, ...facts }
}
