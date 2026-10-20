import LlmKeyPanel from './llm-key-panel'
import PlanPanel from './plan-panel'

export default function Settings() {
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold mb-1">Settings</h1>
      <p className="text-gray-400 text-sm mb-8">Connect your accounts and configure your GTM agent.</p>

      <PlanPanel />
      <LlmKeyPanel />

      {/* Gmail */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-4">
        <h2 className="font-semibold mb-1">Gmail</h2>
        <p className="text-gray-400 text-sm mb-4">Your outreach sends from your own inbox. Required to start sending.</p>
        <form className="flex flex-col gap-3" action="/api/settings/gmail" method="POST">
          <input name="gmail_user" type="email" placeholder="you@gmail.com"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm" />
          <input name="gmail_password" type="password" placeholder="App password (not your Google password)"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm" />
          <button type="submit" className="bg-indigo-500 hover:bg-indigo-400 px-5 py-2 rounded-xl text-sm font-medium transition w-fit">
            Save Gmail
          </button>
        </form>
      </div>

      {/* Business */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-4">
        <h2 className="font-semibold mb-1">Your business</h2>
        <p className="text-gray-400 text-sm mb-4">Tell dazl what you sell so it can find the right buyers.</p>
        <form className="flex flex-col gap-3" action="/api/settings/business" method="POST">
          <input name="business_name" type="text" placeholder="Company (optional)"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm" />
          <textarea name="what_you_sell" rows={3} placeholder="What do you sell? Who buys it? What problem does it solve?"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm resize-none" />
          <input name="icp" type="text" placeholder="Ideal customer (e.g. SaaS founders, dental practices, e-commerce stores)"
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 text-sm" />
          <button type="submit" className="bg-indigo-500 hover:bg-indigo-400 px-5 py-2 rounded-xl text-sm font-medium transition w-fit">
            Save
          </button>
        </form>
      </div>

      {/* Research accounts */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-4">
        <h2 className="font-semibold mb-1">Research accounts</h2>
        <p className="text-gray-400 text-sm mb-4">Connect your accounts so dazl reads Reddit, LinkedIn, Twitter, G2 through your real logged-in session — no blocks, no limits.</p>
        <div className="flex flex-col gap-3">
          {[
            { name: 'LinkedIn', desc: 'Job signals, competitor posts, profile changes' },
            { name: 'Reddit', desc: 'Buying intent in comments, pain point threads' },
            { name: 'Twitter / X', desc: 'Competitor mentions, people complaining about problems you solve' },
            { name: 'G2 / Capterra', desc: 'Competitor negative reviews = people actively shopping' },
          ].map(p => (
            <div key={p.name} className="flex items-center justify-between bg-white/5 rounded-xl px-4 py-3">
              <div>
                <div className="font-medium text-sm">{p.name}</div>
                <div className="text-gray-500 text-xs">{p.desc}</div>
              </div>
              <button className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition">Connect</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
