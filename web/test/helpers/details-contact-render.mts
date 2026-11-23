// Third and fourth reviews of #1578: renders the real Details contact component (app/app/leads/details-contact.tsx) for the lead rows
// it is handed as JSON on stdin and prints, for each, (a) its markup (react-dom/server) and (b) what every button in it calls when
// clicked: the component uses no hooks, so it is called directly and its element tree walked. No fixture and no assertion lives here:
// the parent test (test/discover-recipient-age-1578.test.ts) builds the rows with the product's own steps and reads the result. The
// component is .tsx and needs a loader (test/helpers/tsx-loader.mjs), so this runs in its own process; any network call fails it.
import { createElement as h, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { DetailsContact } from '../../app/app/leads/details-contact.tsx'
import type { DetailsContactLead } from '../../app/app/leads/details-contact.tsx'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${u}`) }) as typeof fetch
type In = { l: DetailsContactLead; reviewMsg?: string; contactMsg?: string; drafted?: string }
type El = { type: unknown; props: Record<string, unknown> }
const walk = (n: ReactNode, f: (e: El) => void): void => {
  if (n == null || typeof n === 'boolean' || typeof n === 'string' || typeof n === 'number') return
  if (Array.isArray(n)) { n.forEach(x => walk(x, f)); return }
  if (isValidElement(n)) { const e = n as unknown as El; f(e); walk(e.props.children as ReactNode, f) }
}
const text = (n: ReactNode): string => typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(text).join('') : isValidElement(n) ? text((n as unknown as El).props.children as ReactNode) : ''

const rows = JSON.parse(readFileSync(0, 'utf8')) as Record<string, In>
const out: Record<string, { html: string; clicks: string[] }> = {}
for (const [name, r] of Object.entries(rows)) {
  const calls: [string, unknown[]][] = []
  const spy = (n: string) => (...a: unknown[]) => { calls.push([n, a]) }
  const props = { ...r, onDomainReview: spy('domainReview'), onFindContact: spy('findContact'), onConfirmReview: spy('confirmReview'), onApprove: spy('approveLead') }
  const clicks: string[] = []
  walk((DetailsContact as unknown as (p: typeof props) => ReactNode)(props), e => {
    if (e.type !== 'button') return
    calls.length = 0; (e.props.onClick as () => void)()
    clicks.push(`${text(e.props.children as ReactNode)} => ${JSON.stringify(calls)}`)
  })
  out[name] = { html: renderToStaticMarkup(h(DetailsContact, props)), clicks }
}
process.stdout.write(`DETAILS-CONTACT-MARKUP ${JSON.stringify(out)}\n`)
