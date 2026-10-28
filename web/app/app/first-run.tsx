'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import KeyInline from './key-inline'
import { normalizeWebsite, suggestPlays, type Brain } from '@/lib/onboarding'
import { knownErrorCopy } from '@/lib/error-copy'

type Step = 'site' | 'brain' | 'ask'
interface Usage { has_key: boolean; trial: { funded: boolean; remaining: number } | null }

const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
const SITE_ERR: Record<string, string> = {
  invalid: 'That address is not a public website.', not_public: 'That address is not a public website.',
  js_only: 'We could not read enough text from that page (it may need JavaScript). Try your about page, or fill in the profile yourself.',
  not_html: 'We could not read enough text from that page. Try your about page, or fill in the profile yourself.',
  blocked: 'That site did not let us read it. Fill in the profile yourself instead.', timeout: 'That site took too long to answer. Try again, or fill in the profile yourself.',
}

// First run on Home: website -> editable "what you sell and who buys it" -> one sentence (3 suggested plays) -> Run.
// Shown to a new account (no business details, no searches); after that Home shows the journey (the children).
export default function FirstRun({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState<'loading' | 'wizard' | 'home'>('loading')
  const [usage, setUsage] = useState<Usage | null>(null)
  const [step, setStep] = useState<Step>('site')
  const [website, setWebsite] = useState('')
  const [bizName, setBizName] = useState('')
  const [sells, setSells] = useState('')
  const [summary, setSummary] = useState('')
  const [who, setWho] = useState('')
  const [industries, setIndustries] = useState('')
  const [where, setWhere] = useState('')
  const [signals, setSignals] = useState('')
  const [sizes, setSizes] = useState('')
  const [exclude, setExclude] = useState('')
  const [readFrom, setReadFrom] = useState('')
  const [ask, setAsk] = useState('')
  // True while the sentence is a suggestion (picked or prefilled), false once the user types their own. A suggestion is
  // replaced when the profile changes, so the box never keeps a sentence built from an older profile.
  const [askIsSuggestion, setAskIsSuggestion] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [needKey, setNeedKey] = useState(false)

  // Fills the step-2 buyer fields from a profile (the saved one on load, or a fresh website read).
  const fillBuyer = (b: Partial<Brain> & { sizes?: string[]; exclude?: string[] }) => {
    const j = (v?: string[]) => (v ?? []).join(', ')
    setSummary(b.summary ?? ''); setWho(j(b.who)); setIndustries(j(b.industries)); setWhere(j(b.where)); setSignals(j(b.signals)); setSizes(j(b.sizes)); setExclude(j(b.exclude))
  }
  const loadUsage = () => fetch('/api/usage').then(r => r.ok ? r.json() : null).then(j => { if (j) setUsage(j) }).catch(() => {})
  useEffect(() => {
    void Promise.all([
      fetch('/api/scan/jobs').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/settings/profile').then(r => r.ok ? r.json() : null).catch(() => null),
      loadUsage(),
    ]).then(([jobs, profile]) => {
      if (profile) {
        setWebsite(String(profile.website ?? '')); setSells(String(profile.sells ?? '')); setBizName(String(profile.business_name ?? ''))
        if (profile.buyer) fillBuyer(profile.buyer)
      }
      // ?setup=brain (the Home checklist's "Build" link) reopens these steps at the buyer profile for any account;
      // ?setup=site starts them at the website.
      const setup = new URLSearchParams(window.location.search).get('setup')
      if (setup === 'brain') { setStep(profile?.website || profile?.sells ? 'brain' : 'site'); setReady('wizard'); return }
      if (setup === 'site') { setReady('wizard'); return }
      // A new account (nothing known about the business, no searches) gets the steps; every other account gets the
      // journey, which asks for the business itself when it is missing. Anything unreadable falls back to the normal
      // Home rather than trapping a returning user in the wizard.
      const known = !!(profile && (profile.website || profile.sells || profile.buyer))
      setReady(profile && !known && jobs && Array.isArray(jobs.jobs) && jobs.jobs.length === 0 ? 'wizard' : 'home')
    })
  }, [])

  const brain: Brain = { summary: summary || sells, who: list(who), industries: list(industries), where: list(where), signals: list(signals) }
  const plays = useMemo(() => suggestPlays(brain), [summary, sells, who, industries, where, signals]) // eslint-disable-line react-hooks/exhaustive-deps
  // The reviewed profile exactly as shown in step 2; it goes to the search with the sentence (no hidden fields).
  const profile = { summary: (summary || sells).trim(), who: list(who), industries: list(industries), sizes: list(sizes), where: list(where), signals: list(signals), exclude: list(exclude) }

  if (ready === 'loading') return null
  if (ready === 'home') return <>{children}</>

  const hasKey = !!usage?.has_key
  const trialLeft = !hasKey && usage?.trial?.funded ? usage.trial.remaining : 0

  async function readSite(e?: React.FormEvent) {
    e?.preventDefault(); setError('')
    const url = normalizeWebsite(website)
    if (!url) return setError('Enter your website, like acme.com.')
    setBusy(true)
    try {
      const r = await fetch('/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (j.error === 'no_api_key') { setNeedKey(true); return }
        return setError(knownErrorCopy(j.error) ?? SITE_ERR[j.error] ?? (r.status === 429 ? 'Too many website reads. Try again later, or fill in the profile yourself.' : 'Could not read that site. Fill in the profile yourself instead.'))
      }
      if (j.sells) setSells(String(j.sells))
      fillBuyer(j.icp)
      try { setReadFrom(new URL(j.source).hostname) } catch { setReadFrom('your website') }
      setWebsite(url); setStep('brain')
    } catch { setError('Could not reach the server. Check your connection and try again.') } finally { setBusy(false) }
  }

  async function saveBrain(e: React.FormEvent) {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sells, website: normalizeWebsite(website), business_name: bizName, buyer: profile }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return setError(j.error || 'Could not save')
      window.dispatchEvent(new Event('profile-updated')) // the Home checklist re-reads the saved profile
      if (askIsSuggestion || !ask.trim()) { setAsk(plays[0] || ''); setAskIsSuggestion(true) }
      setStep('ask')
    } catch { setError('Could not reach the server. Try again.') } finally { setBusy(false) }
  }

  async function run(e: React.FormEvent) {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      // The sentence on screen and the profile from step 2, as the Leads page sends a reviewed profile. The server
      // validates both; nothing here changes what a scan checks.
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: ask.trim(), icp: profile }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.job_id) { router.push(`/app/leads?job_id=${encodeURIComponent(j.job_id)}`); return }
      if (j.error === 'no_api_key' || j.error === 'trial_exhausted') { setNeedKey(true); return setError(j.error === 'trial_exhausted' ? 'Your free scans are used up. Add your AI key to keep going.' : '') }
      setError(knownErrorCopy(j.error) ?? (j.error === 'quota_exceeded' ? `You have used ${j.used} of ${j.limit} scans on your plan.` : j.error || 'Could not start the search.'))
    } catch { setError('Could not reach the server. Check your connection and try again.') } finally { setBusy(false) }
  }

  const dot = (s: Step, n: number, label: string) => <li className={`flex items-center gap-2 ${step === s ? 'text-[#111] font-medium' : 'text-[#888]'}`}><span className={`w-6 h-6 rounded-full text-xs flex items-center justify-center ${step === s ? 'bg-[#111] text-white' : 'bg-black/5'}`}>{n}</span>{label}</li>
  return (
    <div className="max-w-2xl">
      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm mb-6" aria-label="Setup steps">{dot('site', 1, 'Your website')}{dot('brain', 2, 'What you sell')}{dot('ask', 3, 'Who to reach')}</ol>
      {error && <p className="text-sm text-[#111] border-l-2 border-[#111] pl-3 mb-4" role="alert">{error}</p>}

      {step === 'site' && <div className="card p-6">
        <h2 className="text-xl font-semibold mb-1">What&apos;s your website?</h2>
        <p className="text-sm text-[#555] mb-4">dazl reads your homepage and drafts what you sell and who buys it. You can edit everything.</p>
        {needKey && !hasKey ? <KeyInline reason="Reading your site runs on your own Anthropic or OpenAI key." onSaved={() => { setNeedKey(false); void loadUsage().then(() => readSite()) }} /> : null}
        <form onSubmit={readSite} className="flex gap-2 mt-3">
          <input className="field flex-1" aria-label="Your website" placeholder="acme.com" maxLength={200} value={website} onChange={e => setWebsite(e.target.value)} />
          <button className="btn-primary" disabled={busy || website.trim().length < 4}>{busy ? 'Reading your site...' : 'Read my site'}</button>
        </form>
        <button type="button" className="text-xs underline text-[#555] mt-3" onClick={() => { setError(''); setStep('brain') }}>No website? Describe your business yourself</button>
      </div>}

      {step === 'brain' && <form onSubmit={saveBrain} className="card p-6 flex flex-col gap-3 text-sm">
        <h2 className="text-xl font-semibold">Here&apos;s what we think you sell and who buys it</h2>
        <p className="text-[#555]">{readFrom ? `Drafted from ${readFrom}. ` : ''}Edit anything that is off. Saved to your account; your first search uses all of it.</p>
        <label className="flex flex-col gap-1">Business name <span className="text-xs text-[#777]">used in your email drafts</span><input className="field" maxLength={150} value={bizName} onChange={e => setBizName(e.target.value)} /></label>
        <label className="flex flex-col gap-1">What you sell<input className="field" required minLength={3} maxLength={150} value={sells} onChange={e => setSells(e.target.value)} placeholder="e.g. Scheduling software for dental practices" /></label>
        <label className="flex flex-col gap-1">Who buys it<textarea className="field" rows={2} maxLength={400} value={summary} onChange={e => setSummary(e.target.value)} placeholder="e.g. Independent dental practices with 2-10 chairs" /></label>
        <label className="flex flex-col gap-1">Buyer roles <span className="text-xs text-[#777]">comma separated</span><input className="field" value={who} onChange={e => setWho(e.target.value)} placeholder="Practice owner, Office manager" /></label>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">Industries<input className="field" value={industries} onChange={e => setIndustries(e.target.value)} placeholder="Dental" /></label>
          <label className="flex flex-col gap-1">Where<input className="field" value={where} onChange={e => setWhere(e.target.value)} placeholder="Ohio" /></label>
        </div>
        <label className="flex flex-col gap-1">Signs they need you now <span className="text-xs text-[#777]">comma separated public events</span><input className="field" value={signals} onChange={e => setSignals(e.target.value)} placeholder="Opened a new location, hiring front-desk staff" /></label>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">Company sizes <span className="text-xs text-[#777]">optional</span><input className="field" value={sizes} onChange={e => setSizes(e.target.value)} placeholder="2-50 employees" /></label>
          <label className="flex flex-col gap-1">Skip <span className="text-xs text-[#777]">optional</span><input className="field" value={exclude} onChange={e => setExclude(e.target.value)} placeholder="Dental schools, chains" /></label>
        </div>
        <div className="flex gap-3 items-center mt-1">
          <button className="btn-primary" disabled={busy || sells.trim().length < 3}>{busy ? 'Saving...' : 'Looks right, continue'}</button>
          <button type="button" className="text-xs underline text-[#555]" onClick={() => setStep('site')}>Back</button>
        </div>
      </form>}

      {step === 'ask' && <form onSubmit={run} className="card p-6 flex flex-col gap-3 text-sm">
        <h2 className="text-xl font-semibold">Who do you want to reach?</h2>
        <p className="text-[#555]">One sentence. Pick a suggestion or write your own.</p>
        <div className="flex flex-col gap-2" role="group" aria-label="Suggested plays">
          {plays.map(p => <button type="button" key={p} aria-pressed={ask === p} onClick={() => { setAsk(p); setAskIsSuggestion(true) }} className={`text-left border rounded-lg px-3 py-2 ${ask === p ? 'border-[#111] bg-black/5' : 'border-black/15 hover:border-black/40'}`}>{p}</button>)}
        </div>
        <textarea className="field" rows={2} required minLength={3} maxLength={600} aria-label="Who do you want to reach" value={ask} onChange={e => { setAsk(e.target.value); setAskIsSuggestion(false) }} />
        <p className="text-xs text-[#555]" aria-label="Search profile">Searched with your profile: {[profile.who.join(', '), profile.industries.join(', '), profile.where.length ? `in ${profile.where.join(', ')}` : 'any location', profile.sizes.join(', '), profile.exclude.length ? `skipping ${profile.exclude.join(', ')}` : ''].filter(Boolean).join(' · ')}. <button type="button" className="underline" onClick={() => setStep('brain')}>Edit</button></p>
        {needKey && !hasKey ? <KeyInline reason="Searches run on your own Anthropic or OpenAI key." onSaved={() => { setNeedKey(false); setError(''); void loadUsage() }} />
          : !hasKey && trialLeft > 0 ? <p className="text-xs text-[#555]">Your first {trialLeft} search{trialLeft === 1 ? '' : 'es'} are on us. No AI key needed yet.</p> : null}
        <div className="flex gap-3 items-center">
          <button className="btn-primary" disabled={busy || ask.trim().length < 3}>{busy ? 'Starting...' : 'Find leads'}</button>
          <button type="button" className="text-xs underline text-[#555]" onClick={() => setStep('brain')}>Back</button>
        </div>
        <p className="text-xs text-[#777]">Leads arrive on the Leads page with their sources. Nothing is emailed until you approve it.</p>
      </form>}

      <button type="button" className="text-xs text-[#777] underline mt-6" onClick={() => setReady('home')}>Skip setup and show all options</button>
    </div>
  )
}
