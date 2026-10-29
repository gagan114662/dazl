// The onboarding "brain": the facts dazl inferred from the user's own website, as nodes for the graph. Pure and
// display-only. Only what the website read returned is shown (lib/scan/icp-from-site.ts: what they sell and the buyer
// profile); nothing is added, guessed or padded to look fuller.
export type FactKind = 'company' | 'product' | 'buyer' | 'persona' | 'industry' | 'place' | 'size' | 'signal' | 'skip'
export interface BrainFact { kind: FactKind; label: string; text: string }
export interface SiteRead { source?: string; sells?: string; business_name?: string; icp?: { summary?: string; who?: string[]; industries?: string[]; where?: string[]; sizes?: string[]; signals?: string[]; exclude?: string[] } }

const LABEL: Record<FactKind, string> = { company: 'Company', product: 'Product', buyer: 'Ideal customer', persona: 'Persona', industry: 'Industry', place: 'Region', size: 'Company size', signal: 'Buying signal', skip: 'Skip' }
const clean = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''

export function brainFacts(r: SiteRead): BrainFact[] {
  const out: BrainFact[] = []
  const add = (kind: FactKind, v: unknown) => { const t = clean(v); if (t && !out.some(f => f.kind === kind && f.text.toLowerCase() === t.toLowerCase())) out.push({ kind, label: LABEL[kind], text: t.slice(0, 120) }) }
  let host = ''
  try { host = r.source ? new URL(r.source).hostname.replace(/^www\./, '') : '' } catch { host = '' }
  add('company', clean(r.business_name) || host)
  add('product', r.sells)
  add('buyer', r.icp?.summary)
  for (const v of r.icp?.who ?? []) add('persona', v)
  for (const v of r.icp?.industries ?? []) add('industry', v)
  for (const v of r.icp?.where ?? []) add('place', v)
  for (const v of r.icp?.sizes ?? []) add('size', v)
  for (const v of r.icp?.signals ?? []) add('signal', v)
  for (const v of r.icp?.exclude ?? []) add('skip', v)
  return out
}
