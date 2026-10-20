import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-white/10">
        <span className="text-xl font-bold tracking-tight">dazl<span className="text-indigo-400">.</span></span>
        <div className="flex gap-4 items-center">
          <Link href="/sign-in" className="text-sm text-gray-400 hover:text-white transition">Sign in</Link>
          <Link href="/sign-up" className="text-sm bg-indigo-500 hover:bg-indigo-400 px-4 py-2 rounded-lg font-medium transition">Start free</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center justify-center text-center flex-1 px-6 py-24 gap-6">
        <div className="text-xs font-semibold tracking-widest text-indigo-400 uppercase">Find · Reach · Book · Paid</div>
        <h1 className="text-5xl md:text-6xl font-bold max-w-3xl leading-tight">
          One agent that finds customers,<br/>reaches them, and books the work.
        </h1>
        <p className="text-lg text-gray-400 max-w-xl">
          dazl watches 30+ live signals — Reddit, LinkedIn, funding rounds, competitor reviews, job posts — finds buyers right now, emails them, handles replies, books meetings, and takes payment. You just show up.
        </p>
        <div className="flex gap-4 mt-2">
          <Link href="/sign-up" className="bg-indigo-500 hover:bg-indigo-400 px-8 py-3 rounded-xl font-semibold text-lg transition">
            Start free — CA$99/mo after trial
          </Link>
        </div>
        <p className="text-sm text-gray-500">14 days free. No credit card to start.</p>
      </section>

      {/* Feature grid */}
      <section className="grid md:grid-cols-3 gap-6 px-8 py-16 max-w-5xl mx-auto w-full">
        {[
          { title: '30+ live signals', desc: 'Reddit intent, LinkedIn job changes, funding rounds, competitor reviews, permit filings, property sales — cited with source URL.' },
          { title: 'Reaches them first', desc: 'Hyper-personalised email + LinkedIn outreach that references the exact signal. 3-step follow-up sequence that stops the moment they reply.' },
          { title: 'Closes the loop', desc: 'Handles every reply, books calendar meetings, sends Stripe payment links. Neither Gojiberry nor Gooseworks does all of this.' },
        ].map(f => (
          <div key={f.title} className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
            <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
          </div>
        ))}
      </section>

      {/* Pricing */}
      <section className="text-center px-8 py-16 border-t border-white/10">
        <h2 className="text-3xl font-bold mb-2">One plan. Everything included.</h2>
        <p className="text-gray-400 mb-8">Every feature, every channel, every integration.</p>
        <div className="inline-block bg-white/5 border border-white/10 rounded-2xl p-8 max-w-sm w-full">
          <div className="text-5xl font-bold mb-1">CA$99<span className="text-xl font-normal text-gray-400">/mo</span></div>
          <p className="text-gray-400 text-sm mb-6">Start free — CA$99/mo after 14-day trial</p>
          <Link href="/sign-up" className="block w-full bg-indigo-500 hover:bg-indigo-400 px-6 py-3 rounded-xl font-semibold transition text-center">
            Start free trial
          </Link>
          <ul className="text-left mt-6 space-y-2 text-sm text-gray-300">
            {['30+ signal sources', 'Email + LinkedIn outreach', '3-step follow-up sequences', 'Auto calendar booking', 'Stripe payment links', '24/7 front desk', 'Marketing content generator', 'Unlimited businesses'].map(f => (
              <li key={f} className="flex gap-2 items-center"><span className="text-indigo-400">✓</span>{f}</li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="text-center py-8 text-gray-600 text-sm border-t border-white/10">
        © 2026 dazl · <a href="/terms" className="hover:text-gray-400">Terms</a>
      </footer>
    </main>
  )
}
