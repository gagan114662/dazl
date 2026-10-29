// Prints which Terms/Privacy fields are still missing and exits 1 until both pages are final (no placeholder, no DRAFT banner).
// Validation only: it never writes or publishes policy text. Run: node --experimental-strip-types scripts/legal-check.mts
import { readFileSync } from 'node:fs'
import { legalReport, type LegalPage } from '../lib/legal-fields.ts'
let bad = 0
for (const p of ['terms', 'privacy'] as LegalPage[]) {
  const r = legalReport(p, readFileSync(new URL(`../app/${p}/page.tsx`, import.meta.url), 'utf8'))
  console.log(`${p}: ${r.final ? 'final' : `NOT final${r.draftBanner ? ' (DRAFT banner)' : ''}`}`)
  for (const f of r.missing) console.log(`  - ${f.token}  ${f.name}: needs ${f.needs} (${f.owner})`)
  for (const t of r.unlisted) console.log(`  - ${t}  not in LEGAL_FIELDS: add it`)
  if (!r.final) bad++
}
process.exit(bad ? 1 : 0)
