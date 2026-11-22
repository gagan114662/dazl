// What a lead from the Claude discovery lane says about itself on its card: how sure dazl is, and plainly what is missing
// (launch brief, Step 3: a missing date, person or website lowers confidence and is said; it never hides the lead).
export interface DiscoverCardLead {
  source_kind?: string | null; confidence: number | null; event_date: string | null; date_status?: string | null; timing_note?: string | null
  name: string; company_domain: string | null; enrichments?: { kind: string; connector?: string }[]
}
export const isDiscoverLead = (l: { source_kind?: string | null }): boolean => l.source_kind === 'discover'
export function discoverConfidence(l: Pick<DiscoverCardLead, 'confidence'>): 'high' | 'medium' | 'low' {
  const c = l.confidence ?? 0
  return c >= 80 ? 'high' : c >= 60 ? 'medium' : 'low'
}
export function discoverMissing(l: DiscoverCardLead): string[] {
  const missing: string[] = []
  if (!l.event_date) missing.push('a date for the signal')
  else if (l.date_status !== 'verified') missing.push(l.timing_note ? 'a date printed on the page (the date shown is when the page was published)' : 'the date confirmed on the page')
  if (!l.name.trim() && !(l.enrichments ?? []).some(e => e.kind === 'person')) missing.push('a named person')
  if (!l.company_domain) missing.push('the company website')
  return missing
}
export function discoverLine(l: DiscoverCardLead): string {
  const missing = discoverMissing(l)
  return `Confidence: ${discoverConfidence(l)}. ${missing.length ? `Missing: ${missing.join('; ')}.` : 'Dated signal, proof page, person and website all found.'}`
}

// Where each fact on a discovery lead came from (#1401): the page that proves the signal, the page that names the person, the page
// that prints the email. Only links the run stored; nothing is inferred.
export interface FieldSource { field: 'signal' | 'person' | 'email' | 'linkedin'; label: string; url: string }
export function discoverSources(l: { source_url?: string | null; enrichments?: { kind: string; connector?: string; value?: string; source_url?: string | null }[] }): FieldSource[] {
  const out: FieldSource[] = []
  if (l.source_url) out.push({ field: 'signal', label: 'Signal', url: l.source_url })
  const from = (kind: string) => (l.enrichments ?? []).find(e => e.kind === kind && e.connector === 'discover' && e.source_url)
  const person = from('person'), email = from('email'), linkedin = from('linkedin')
  if (person) out.push({ field: 'person', label: 'Person', url: person.source_url! })
  if (email) out.push({ field: 'email', label: 'Email', url: email.source_url! })
  if (linkedin?.value) out.push({ field: 'linkedin', label: 'LinkedIn', url: linkedin.value })
  return out
}
