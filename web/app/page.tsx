import Link from 'next/link'

const STEPS = [
  { n: '1', title: 'Say what you want', desc: 'One sentence in plain words, any industry, any country. No forms about your company.' },
  { n: '2', title: 'dazl builds the profile', desc: 'It works out who the ideal buyer is and what buying signals to look for. You can edit it before anything runs.' },
  { n: '3', title: 'Every lead is checked', desc: 'Each lead links to its source page and quotes the exact line. dazl confirms the company and date on the page, and drops what fails.' },
]
const FEATURES = [
  { title: 'Proof on every lead', desc: 'Source link, exact quote, event date and a confidence score. Leads that cannot be verified never reach your list, and you see how many were dropped and why.' },
  { title: 'Your key, your cost', desc: 'Bring your own Anthropic or OpenAI key. Usage is billed by the provider at cost, and your key is encrypted at rest.' },
  { title: 'You approve every send', desc: 'Email goes from your own Gmail, one message at a time, after you approve the exact text. Unsubscribe links are built in and honored right away.' },
]

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col glow relative overflow-hidden">
      <div className="grid-fade absolute inset-x-0 top-0 h-[40rem] pointer-events-none" />
      <nav className="relative flex items-center justify-between px-6 md:px-10 py-5 max-w-6xl mx-auto w-full">
        <span className="text-xl font-bold tracking-tight">dazl<span className="text-indigo-400">.</span></span>
        <div className="flex gap-3 items-center">
          <Link href="/sign-in" className="text-sm text-gray-400 hover:text-white transition px-3 py-2">Sign in</Link>
          <Link href="/sign-up" className="btn-primary mono">Start free</Link>
        </div>
      </nav>

      <div className="rails relative max-w-6xl mx-auto w-full">
        <section className="px-6 md:px-12 pt-16 pb-10">
          <span className="badge mono">Find · Verify · Reach</span>
          <h1 className="text-5xl md:text-7xl font-semibold leading-[1.04] tracking-tight mt-6 max-w-4xl">Where buyers get found, and proven.</h1>
          <p className="text-xl md:text-2xl text-gray-400 mt-5 max-w-3xl leading-snug">Tell dazl who you are looking for in plain words. It searches the web for buyers showing intent right now, and checks every lead against the page it came from.</p>
          <div className="flex flex-wrap gap-3 mt-8">
            <Link href="/sign-up" className="btn-primary mono">Start for free</Link>
            <a href="#how" className="btn-ghost mono">How it works</a>
          </div>
          <p className="text-sm text-gray-500 mt-4">Free plan: 50 scans a month. Bring your own Anthropic or OpenAI key.</p>
        </section>

        <section className="px-4 md:px-8 pb-14">
          <div className="stage px-4 md:px-10 py-16 md:py-24 flex flex-col items-center gap-3">
            <div className="flex gap-1 rounded-lg bg-white/10 p-1 mono">
              {['Find', 'Verify', 'Review', 'Send'].map((t, i) => <span key={t} className="tab" data-on={i === 0}>{t}</span>)}
            </div>
            <div className="w-full max-w-2xl rounded-xl bg-[#0b0d1f]/90 border border-white/15 p-5 text-left shadow-2xl">
              <div className="text-xs text-gray-500 mb-2">What are you looking for?</div>
              <div className="text-gray-100 text-base md:text-lg">Seed-stage fintech founders in Europe who just hired their first sales rep</div>
              <div className="mt-5 grid gap-2 text-sm border-t border-white/10 pt-4">
                <div className="flex gap-2 items-start"><span className="badge mono shrink-0">verified</span><span className="text-gray-300">Head of Sales role posted after a seed round <span className="text-gray-500">(quote on page, dated this month)</span></span></div>
                <div className="flex gap-2 items-start"><span className="badge mono shrink-0">verified</span><span className="text-gray-300">New Berlin office with two sales roles <span className="text-gray-500">(source linked)</span></span></div>
                <div className="flex gap-2 items-start"><span className="badge mono shrink-0 !text-amber-300 !border-amber-400/30 !bg-amber-400/10">review</span><span className="text-gray-300">Site blocked our check, open the source yourself</span></div>
              </div>
            </div>
            <div className="text-[11px] text-indigo-200/70">Illustration only. Real results depend on your request and the live web.</div>
          </div>
        </section>
      </div>

      <section id="how" className="relative px-6 py-20 max-w-5xl mx-auto w-full">
        <h2 className="text-3xl font-bold tracking-tight text-center mb-12">How it works</h2>
        <div className="grid md:grid-cols-3 gap-5">
          {STEPS.map(s => (
            <div key={s.n} className="card card-hover p-6">
              <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 text-sm font-semibold flex items-center justify-center mb-4">{s.n}</div>
              <h3 className="font-semibold text-lg mb-2">{s.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative px-6 pb-20 max-w-5xl mx-auto w-full">
        <div className="grid md:grid-cols-3 gap-5">
          {FEATURES.map(f => (
            <div key={f.title} className="card card-hover p-6">
              <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative text-center px-6 py-20 border-t border-white/10">
        <h2 className="text-3xl font-bold tracking-tight mb-2">Simple pricing</h2>
        <p className="text-gray-400 mb-10">You pay your AI provider directly for the usage on your own key.</p>
        <div className="flex flex-wrap gap-5 justify-center">
          <div className="card p-8 max-w-xs w-full text-left">
            <div className="text-sm text-gray-400 mb-1">Free</div>
            <div className="text-4xl font-bold mb-1">CA$0</div>
            <p className="text-gray-400 text-sm mb-6">50 scans a month</p>
            <Link href="/sign-up" className="btn-ghost w-full">Start free</Link>
          </div>
          <div className="card p-8 max-w-xs w-full text-left !border-indigo-400/50 shadow-xl shadow-indigo-950/50">
            <div className="text-sm text-indigo-300 mb-1">Pro</div>
            <div className="text-4xl font-bold mb-1">CA$99<span className="text-lg font-normal text-gray-400">/mo</span></div>
            <p className="text-gray-400 text-sm mb-6">Unlimited scans</p>
            <Link href="/sign-up" className="btn-primary w-full">Start free, upgrade any time</Link>
          </div>
        </div>
      </section>

      <footer className="relative text-center py-8 text-gray-600 text-sm border-t border-white/10">
        © 2026 dazl · <a href="/terms" className="hover:text-gray-400">Terms</a> · <a href="/privacy" className="hover:text-gray-400">Privacy</a>
      </footer>
    </main>
  )
}
