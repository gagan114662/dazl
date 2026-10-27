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
// Shown until the account has run its first scan; after that Home shows the usual steps (the `rest` children).
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
  const [readFrom, setReadFrom] = useState('')
  const [ask, setAsk] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [needKey, setNeedKey] = useState(false)

  const loadUsage = () => fetch('/api/usage').then(r => r.ok ? r.json() : null).then(j => { if (j) setUsage(j) }).catch(() => {})
  useEffect(() => {
    void Promise.all([
      fetch('/api/scan/jobs').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/settings/profile').then(r => r.ok ? r.json() : null).catch(() => null),
      loadUsage(),
    ]).then(([jobs, profile]) => {
      if (profile) { setWebsite(String(profile.website ?? '')); setSells(String(profile.sells ?? '')); setBizName(String(profile.business_name ?? '')) }
      // Anything unreadable falls back to the normal Home rather than trapping a returning user in the wizard.
      setReady(jobs && Array.isArray(jobs.jobs) && jobs.jobs.length === 0 ? 'wizard' : 'home')
    })
  }, [])

  const brain: Brain = { summary: summary || sells, who: list(who), industries: list(industries), where: list(where), signals: list(signals) }
  const plays = useMemo(() => suggestPlays(brain), [summary, sells, who, industries, where, signals]) // eslint-disable-line react-hooks/exhaustive-deps

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
      const icp = j.icp as Brain
      if (j.sells) setSells(String(j.sells))
      setSummary(icp.summary ?? ''); setWho((icp.who ?? []).join(', ')); setIndustries((icp.industries ?? []).join(', ')); setWhere((icp.where ?? []).join(', ')); setSignals((icp.signals ?? []).join(', '))
      try { setReadFrom(new URL(j.source).hostname) } catch { setReadFrom('your website') }
      setWebsite(url); setStep('brain')
    } catch { setError('Could not reach the server. Check your connection and try again.') } finally { setBusy(false) }
  }

  async function saveBrain(e: React.FormEvent) {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sells, website: normalizeWebsite(website), business_name: bizName }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return setError(j.error || 'Could not save')
      setAsk(a => a || plays[0] || ''); setStep('ask')
    } catch { setError('Could not reach the server. Try again.') } finally { setBusy(false) }
  }

  async function run(e: React.FormEvent) {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      // The sentence alone goes to the scan; the server builds the profile from it and the saved "what you sell",
      // exactly as on Leads. Nothing here changes what a scan checks.
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: ask.trim() }) })
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
        <p className="text-[#555]">{readFrom ? `Drafted from ${readFrom}. ` : ''}Edit anything that is off. This shapes every search and draft.</p>
        <label className="flex flex-col gap-1">Business name <span className="text-xs text-[#777]">used in your email drafts</span><input className="field" maxLength={150} value={bizName} onChange={e => setBizName(e.target.value)} /></label>
        <label className="flex flex-col gap-1">What you sell<input className="field" required minLength={3} maxLength={150} value={sells} onChange={e => setSells(e.target.value)} placeholder="e.g. Scheduling software for dental practices" /></label>
        <label className="flex flex-col gap-1">Who buys it<textarea className="field" rows={2} maxLength={400} value={summary} onChange={e => setSummary(e.target.value)} placeholder="e.g. Independent dental practices with 2-10 chairs" /></label>
        <label className="flex flex-col gap-1">Buyer roles <span className="text-xs text-[#777]">comma separated</span><input className="field" value={who} onChange={e => setWho(e.target.value)} placeholder="Practice owner, Office manager" /></label>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">Industries<input className="field" value={industries} onChange={e => setIndustries(e.target.value)} placeholder="Dental" /></label>
          <label className="flex flex-col gap-1">Where<input className="field" value={where} onChange={e => setWhere(e.target.value)} placeholder="Ohio" /></label>
        </div>
        <label className="flex flex-col gap-1">Signs they need you now <span className="text-xs text-[#777]">comma separated public events</span><input className="field" value={signals} onChange={e => setSignals(e.target.value)} placeholder="Opened a new location, hiring front-desk staff" /></label>
        <div className="flex gap-3 items-center mt-1">
          <button className="btn-primary" disabled={busy || sells.trim().length < 3}>{busy ? 'Saving...' : 'Looks right, continue'}</button>
          <button type="button" className="text-xs underline text-[#555]" onClick={() => setStep('site')}>Back</button>
        </div>
      </form>}

      {step === 'ask' && <form onSubmit={run} className="card p-6 flex flex-col gap-3 text-sm">
        <h2 className="text-xl font-semibold">Who do you want to reach?</h2>
        <p className="text-[#555]">One sentence. Pick a suggestion or write your own.</p>
        <div className="flex flex-col gap-2" role="group" aria-label="Suggested plays">
          {plays.map(p => <button type="button" key={p} onClick={() => setAsk(p)} className={`text-left border rounded-lg px-3 py-2 ${ask === p ? 'border-[#111] bg-black/5' : 'border-black/15 hover:border-black/40'}`}>{p}</button>)}
        </div>
        <textarea className="field" rows={2} required minLength={3} maxLength={600} aria-label="Who do you want to reach" value={ask} onChange={e => setAsk(e.target.value)} />
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
