import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col" style={{backgroundColor:"#030712",color:"#f9fafb"}}>
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
        <div className="text-xs font-semibold tracking-widest text-indigo-400 uppercase">Find · Verify · Reach</div>
        <h1 className="text-5xl md:text-6xl font-bold max-w-3xl leading-tight">
          Tell dazl who you are looking for.<br/>Get leads with proof.
        </h1>
        <p className="text-lg text-gray-400 max-w-xl">
          Type what you want in plain words. dazl works out the ideal customer profile, searches the web for people and companies showing buying intent right now, and checks every lead against the page it came from. You review, approve and send.
        </p>
        <div className="flex gap-4 mt-2">
          <Link href="/sign-up" className="bg-indigo-500 hover:bg-indigo-400 px-8 py-3 rounded-xl font-semibold text-lg transition">
            Start free
          </Link>
        </div>
        <p className="text-sm text-gray-500">Free plan: 50 scans a month. Bring your own Anthropic or OpenAI key.</p>
      </section>

      {/* Feature grid */}
      <section className="grid md:grid-cols-3 gap-6 px-8 py-16 max-w-5xl mx-auto w-full">
        {[
          { title: 'Just say what you want', desc: 'No forms about your business. Describe the buyer in a sentence, in any industry or country. dazl builds the profile, shows it to you, and you can edit it.' },
          { title: 'Every lead has proof', desc: 'Each lead links to its source, quotes the exact line that shows the signal, and is checked for the right company and a recent date. Leads that fail the check are dropped, and you see how many.' },
          { title: 'You stay in control', desc: 'Emails go out from your own Gmail, one at a time, after you approve the exact text. Every message carries an unsubscribe link, and unsubscribes are honored right away.' },
        ].map(f => (
          <div key={f.title} className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
            <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
          </div>
        ))}
      </section>

      {/* Pricing */}
      <section className="text-center px-8 py-16 border-t border-white/10">
        <h2 className="text-3xl font-bold mb-2">Simple pricing</h2>
        <p className="text-gray-400 mb-8">You pay your AI provider directly for the model usage on your own key.</p>
        <div className="flex flex-wrap gap-6 justify-center">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-8 max-w-xs w-full text-left">
            <div className="text-4xl font-bold mb-1">Free</div>
            <p className="text-gray-400 text-sm mb-4">50 scans a month</p>
            <Link href="/sign-up" className="block w-full bg-white/10 hover:bg-white/20 px-6 py-3 rounded-xl font-semibold transition text-center">Start free</Link>
          </div>
          <div className="bg-white/5 border border-indigo-500/50 rounded-2xl p-8 max-w-xs w-full text-left">
            <div className="text-4xl font-bold mb-1">CA$99<span className="text-xl font-normal text-gray-400">/mo</span></div>
            <p className="text-gray-400 text-sm mb-4">Pro: unlimited scans</p>
            <Link href="/sign-up" className="block w-full bg-indigo-500 hover:bg-indigo-400 px-6 py-3 rounded-xl font-semibold transition text-center">Start free, upgrade any time</Link>
          </div>
        </div>
      </section>

      <footer className="text-center py-8 text-gray-600 text-sm border-t border-white/10">
        © 2026 dazl · <a href="/terms" className="hover:text-gray-400">Terms</a> · <a href="/privacy" className="hover:text-gray-400">Privacy</a>
      </footer>
    </main>
  )
}
