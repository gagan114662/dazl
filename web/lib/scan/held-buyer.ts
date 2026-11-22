import { isPersonName } from '../connectors/sitecrawl.ts'
import type { Enrichment } from '../connectors/store.ts'
// Run d84a33a0 (UpGuard): a held company-first row shows the buyer the crawl stored from the company's own site, plainly: name and title
// only. Never an email, contact, LinkedIn, label or provenance - the hold itself is unchanged and nothing here makes the row actionable.
export function heldBuyer(enr: readonly Enrichment[] | undefined): { name: string; title: string } | null {
  for (const e of enr ?? []) {
    if (e.connector !== 'sitecrawl' || e.kind !== 'person') continue
    const i = e.value.indexOf(', ')
    const name = (i > 0 ? e.value.slice(0, i) : e.value).trim(), title = i > 0 ? e.value.slice(i + 2).trim() : ''
    if (name && title && isPersonName(name)) return { name: name.slice(0, 120), title: title.slice(0, 120) }
  }
  return null
}
