// Replays the proof check (lib/discover/check.ts) over discovery leads that are already stored, so a change to the check is measured
// on the same leads before and after: one line per lead with its reason, then the count. No model call, no search, nothing written.
//
//   cd web && node --experimental-strip-types --no-warnings scripts/discover-proof-replay.mts <leads.json> [--read] [--check <check.ts>]
//
// <leads.json>: an array of { id?, company, signal, source_url, evidence_excerpt } as a discovery lead is stored, for example
//   SELECT substr(id,1,8) AS id, company, signal, source_url, evidence_excerpt FROM leads WHERE source_kind = 'discover' ORDER BY retrieved_at
// Keep that file outside the repository: it holds lead data and the repository is public.
// Default: does the stored quote state the lead's claim (the rule alone, no network).
// --read: dazl also reads each proof page now and the line says whether the lead would be shown. A stored lead keeps neither the text
//   the run's reader returned nor its search results, so this replays the "read by dazl" path only; a page that has changed or that
//   refuses dazl reads differently from the day of the run.
// --check: another copy of check.ts to measure with, for the count before a change:
//   git show <commit>:web/lib/discover/check.ts > /tmp/check-before.ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DiscoveredLead } from '../lib/discover/agent.ts'

type Check = typeof import('../lib/discover/check.ts')
type Row = { id?: string; company?: string; signal?: string; source_url?: string; evidence_excerpt?: string | null }

const argv = process.argv.slice(2)
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const other = opt('check')
const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--check')
if (!file) { console.error('usage: discover-proof-replay.mts <leads.json> [--read] [--check <check.ts>]'); process.exit(2) }
const read = argv.includes('--read')
const check = (other ? await import(pathToFileURL(path.resolve(other)).href) : await import('../lib/discover/check.ts')) as Check
const rows = JSON.parse(readFileSync(file, 'utf8')) as Row[]
if (!Array.isArray(rows) || !rows.length) { console.error('no leads in the file'); process.exit(2) }

let stated = 0, shown = 0
for (const [i, r] of rows.entries()) {
  const company = String(r.company ?? ''), signal = String(r.signal ?? ''), excerpt = String(r.evidence_excerpt ?? '')
  // a lead with no quote is stored with its signal line as the excerpt (lib/scan/runner.ts discoveredLead)
  const quote = excerpt && excerpt !== signal.slice(0, 400) ? excerpt : null
  const w = check.signalWordsIn(signal, company, quote ?? '')
  const states = !!quote && check.statesSignal(signal, company, quote)
  if (states) stated++
  // the claim is the line's first statement where this copy of check.ts has that rule, else the whole line
  const first = (check as Partial<Check>).leadStatement
  const c = (first ? check.signalWordsIn(first(signal, company), company, quote ?? '') : w) as { want: number; found: number; missing?: string[] }
  let line = !quote ? 'no quote stored' : `${states ? 'quote states the claim' : 'quote does NOT state the claim'}: ${c.found} of ${c.want} claim words${c.missing?.length ? `, lacks: ${c.missing.join(', ')}` : ''}${first ? ` (whole line ${w.found} of ${w.want})` : ''}`
  if (read) {
    const lead: DiscoveredLead = { company, domain: null, signal, signal_date: null, evidence_url: String(r.source_url ?? ''), evidence_quote: quote, person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'medium', why: '' }
    const c = await check.checkLead(lead, [])
    if (check.isShown(c)) shown++
    line += `; page ${c.proof}${c.proof === 'confirmed' ? `, quote ${c.quote_on_page ? 'on' : 'not on'} the page` : ''}; ${check.isShown(c) ? 'SHOWN' : 'review'}`
  }
  console.log(`${String(i + 1).padStart(2)}. ${(r.id ?? '').padEnd(8)} ${company.slice(0, 36).padEnd(36)} ${line}`)
}
console.log(`\nquote states the claim: ${stated} of ${rows.length}${read ? `; shown after dazl's own read of the page: ${shown} of ${rows.length}` : ''}`)
