// Third review of #1578: renders the real Details contact component (app/app/leads/details-contact.tsx) with react-dom/server for the
// lead rows it is handed as JSON on stdin, and prints the markup of each. No fixture and no assertion lives here: the parent test
// (test/discover-recipient-age-1578.test.ts) builds the rows with the product's own steps and reads the markup. The component is .tsx
// and needs a loader (test/helpers/tsx-loader.mjs), so this runs in its own process; any network call fails it.
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { DetailsContact } from '../../app/app/leads/details-contact.tsx'
import type { DetailsContactLead } from '../../app/app/leads/details-contact.tsx'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${u}`) }) as typeof fetch
const rows = JSON.parse(readFileSync(0, 'utf8')) as Record<string, DetailsContactLead>
const noop = () => {}
const out: Record<string, string> = {}
for (const [name, l] of Object.entries(rows)) out[name] = renderToStaticMarkup(h(DetailsContact, { l, onDomainReview: noop, onFindContact: noop, onConfirmReview: noop, onApprove: noop }))
process.stdout.write(`DETAILS-CONTACT-MARKUP ${JSON.stringify(out)}\n`)
