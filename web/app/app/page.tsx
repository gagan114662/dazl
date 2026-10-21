import Link from 'next/link'

export default function AppHome() {
  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Welcome to dazl</h1>
      <p className="text-[#555] text-sm mb-8">Three steps to your first verified leads.</p>
      <div className="grid md:grid-cols-3 gap-4">
        {[
          { n: '1', t: 'Add your AI key', d: 'Scans run on your own Anthropic or OpenAI key.', href: '/app/settings', cta: 'Open Settings' },
          { n: '2', t: 'Say who you want', d: 'One sentence. dazl builds the profile and you can edit it.', href: '/app/leads', cta: 'Go to Leads' },
          { n: '3', t: 'Review verified leads', d: 'Each lead has its source, quote and date. Nothing is sent until you approve.', href: '/app/leads', cta: 'See results' },
        ].map(s => (
          <div key={s.n} className="card card-hover p-5 flex flex-col">
            <div className="w-7 h-7 rounded-full bg-black/5 text-[#111] text-xs font-semibold flex items-center justify-center mb-3">{s.n}</div>
            <div className="font-semibold mb-1">{s.t}</div>
            <p className="text-[#555] text-sm mb-4 flex-1">{s.d}</p>
            <Link href={s.href} className="text-[#111] underline underline-offset-2 text-sm">{s.cta} &rarr;</Link>
          </div>
        ))}
      </div>
    </div>
  )
}
