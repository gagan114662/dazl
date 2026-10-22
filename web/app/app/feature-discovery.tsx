import Link from 'next/link'

// Existing capabilities, with a setup path and limits. No claims of a live connection
// or guaranteed signal coverage: these cards explain what the owner can turn on.
export const DISCOVERY_FEATURES = [
  { title: 'Send leads to your CRM', body: 'Connect HubSpot, Pipedrive or a webhook. Then choose Push to CRM on a lead you want to keep.', href: '/app/settings#crm', cta: 'Connect your CRM' },
  { title: 'Look for buying signals', body: 'Scans can enrich companies with funding news, SEC Form D filings, ATS hiring and public tech-stack clues. Each signal keeps its source; coverage varies by company.', href: '/app/leads', cta: 'Find leads with signals' },
  { title: 'Watch competitor complaints', body: 'Add competitors to look for public Reddit complaints during scans. Requires the Reddit connector and consent. It does not reply or post for you.', href: '/app/settings#competitors', cta: 'Set up competitors' },
  { title: 'Run a saved search again', body: 'After reviewing a profile on Leads, choose Watch this weekly. Recurring scans use the same quota and verification checks as manual scans.', href: '/app/leads', cta: 'Create a watched search' },
  { title: 'Keep your selling context', body: 'Add your positioning, ideal buyers, tone and exclusions to Memory. Drafts and scoring can then use the context you chose.', href: '/app/settings#memory', cta: 'Edit Memory' },
] as const

export default function FeatureDiscovery() {
  return <section className="mt-10" aria-labelledby="discover-heading">
    <h2 id="discover-heading" className="text-xl font-semibold">More you can do with dazl</h2>
    <p className="text-sm text-[#555] mt-2 mb-4">Start with a scan, then connect the parts that fit your workflow.</p>
    <div className="grid sm:grid-cols-2 gap-4">
      {DISCOVERY_FEATURES.map(f => <article key={f.title} className="card p-5 flex flex-col">
        <h3 className="font-semibold mb-2">{f.title}</h3>
        <p className="text-sm text-[#555] mb-4 flex-1">{f.body}</p>
        <Link className="text-sm underline underline-offset-2" href={f.href}>{f.cta} &rarr;</Link>
      </article>)}
    </div>
  </section>
}
