'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import KeyInline from './key-inline'
import { normalizeWebsite, suggestPlays, type Brain } from '@/lib/onboarding'
import { scanRefusalCopy } from '@/lib/trial-copy'
import { knownErrorCopy } from '@/lib/error-copy'
import InfoTip from './ui/info-tip'
import { Icon } from './ui/icons'
import { Avatar, Pill, Stepper } from './ui/bits'
import BrainGraph from './onboarding/brain-graph'
import FirstReview from './onboarding/first-review'
import { brainFacts, type BrainFact } from '@/lib/brain'
import { previewSplit, type PreviewLead } from '@/lib/journey'
import { approveState, leadCardSummary } from '@/lib/scan/lead-card'
import { calendarDay } from '@/lib/day'
import { sourceName, stateText } from '@/lib/source-progress-copy'
import type { First5View } from '@/lib/scan/first5'
import type { SourceProgress } from '@/lib/scan/progress'

type Step = 'site' | 'building' | 'ready' | 'review' | 'brain' | 'ask'
interface Usage { has_key: boolean; trial: { funded: boolean; remaining: number } | null }

// Lists are separated by semicolons, as in Home's profile editor (lib/journey.ts), so an item that contains a comma
// ("London, UK", "Head of Sales, EMEA") stays one item from the read to the scan.
const list = (s: string) => s.split(';').map(x => x.trim()).filter(Boolean)
const REVEAL_MS = 180
// The ready screen's first play is the fast first scan (free sources, seconds rather than minutes): its read-only status
// is polled more often so the live view and the first lead cards keep up with it.
const POLL_MS = 1500
const FIRST = 5
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
  // The brain: facts from the website read, revealed one by one while it builds.
  const [facts, setFacts] = useState<BrainFact[]>([])
  const [shown, setShown] = useState(0)
  // The first play started from the ready screen, watched in place: its status and, once done, its ready leads.
  // f5: the fast first scan's view (lib/scan/first5.ts, served by the status route for a mode=first5 job): live
  // per-source progress, candidates so far and the verified leads. null for a job without it (then the leads read is used).
  const [first, setFirst] = useState<{ id: string; status: string; leads: PreviewLead[] | null; f5: First5View | null; query: string } | null>(null)

  // Fills the step-2 buyer fields from a profile (the saved one on load, or a fresh website read).
  const fillBuyer = (b: Partial<Brain> & { sizes?: string[]; exclude?: string[] }) => {
    const j = (v?: string[]) => (v ?? []).join('; ')
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

  // Watch the first play: its status every few seconds until it settles, then its ready leads (the same gates as Home).
  const firstId = first?.id ?? null, firstStatus = first?.status ?? null
  useEffect(() => {
    if (!firstId || !firstStatus) return
    if (firstStatus === 'done') {
      void fetch(`/api/leads?job_id=${firstId}`).then(r => r.ok ? r.json() : null).catch(() => null).then(j => setFirst(f => f && f.id === firstId ? { ...f, leads: Array.isArray(j?.leads) ? j.leads : [] } : f))
      return
    }
    if (firstStatus === 'failed') return
    const poll = () => void fetch(`/api/scan/status?job_id=${firstId}`).then(r => r.ok ? r.json() : null).catch(() => null).then(j => { if (j?.status) setFirst(f => f && f.id === firstId ? { ...f, status: j.status, f5: j.first5 && typeof j.first5 === 'object' ? j.first5 : f.f5 } : f) })
    // The first read right away (the live view should not sit empty for a whole interval), then every few seconds.
    const t0 = setTimeout(poll, 400)
    const t = setInterval(poll, POLL_MS)
    return () => { clearTimeout(t0); clearInterval(t) }
  }, [firstId, firstStatus])

  if (ready === 'loading') return null
  if (ready === 'home') return <>{children}</>

  const hasKey = !!usage?.has_key
  const trialLeft = !hasKey && usage?.trial?.funded ? usage.trial.remaining : 0

  // Website only: dazl reads it, shows each inferred fact landing on the brain, saves the profile it inferred (the user
  // can edit it any time; nothing is asked up front) and opens the ready screen.
  async function readSite(e?: React.FormEvent) {
    e?.preventDefault(); setError('')
    const url = normalizeWebsite(website)
    if (!url) return setError('Enter your website, like acme.com.')
    setBusy(true); setFacts([]); setShown(0); setStep('building')
    try {
      const r = await fetch('/api/scan/icp-from-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setStep('site')
        if (j.error === 'no_api_key') { setNeedKey(true); return }
        return setError(knownErrorCopy(j.error) ?? SITE_ERR[j.error] ?? (r.status === 429 ? 'Too many website reads. Try again later, or fill in the profile yourself.' : 'Could not read that site. Fill in the profile yourself instead.'))
      }
      if (j.sells) setSells(String(j.sells))
      fillBuyer(j.icp ?? {})
      try { setReadFrom(new URL(j.source).hostname) } catch { setReadFrom('your website') }
      setWebsite(url)
      const f = brainFacts({ ...j, business_name: bizName })
      setFacts(f)
      for (let i = 1; i <= f.length; i++) { setShown(i); await new Promise(res => setTimeout(res, REVEAL_MS)) }
      // Saved exactly as read (the same POST the profile form uses); edited later from Home or "Edit what dazl inferred".
      const b = j.icp ?? {}
      const arr = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      const buyer = { summary: String(b.summary ?? j.sells ?? '').trim(), who: arr(b.who), industries: arr(b.industries), sizes: arr(b.sizes), where: arr(b.where), signals: arr(b.signals), exclude: arr(b.exclude) }
      const sr = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sells: String(j.sells ?? ''), website: url, business_name: bizName, buyer }) }).catch(() => null)
      if (!sr?.ok) { const sj = await sr?.json().catch(() => ({})); setError(sj?.error || 'Could not save what dazl inferred. Check it and save it yourself.'); setStep('brain'); return }
      window.dispatchEvent(new Event('profile-updated'))
      setStep('ready')
    } catch { setStep('site'); setError('Could not reach the server. Check your connection and try again.') } finally { setBusy(false) }
  }

  async function saveBrain(e: React.FormEvent) {
    e.preventDefault(); setError(''); setBusy(true)
    try {
      const r = await fetch('/api/settings/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sells, website: normalizeWebsite(website), business_name: bizName, buyer: profile }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return setError(j.error || 'Could not save')
      window.dispatchEvent(new Event('profile-updated')) // the Home checklist re-reads the saved profile
      // The box starts empty under its three suggestions; a sentence the user typed is kept, a picked suggestion is not.
      if (askIsSuggestion || !ask.trim()) { setAsk(''); setAskIsSuggestion(true) }
      setStep('ask')
    } catch { setError('Could not reach the server. Try again.') } finally { setBusy(false) }
  }

  // One scan from one sentence: the box, or a suggested play picked with one click (it goes in the box and starts at once).
  async function run(e: React.FormEvent) { e.preventDefault(); await start(ask) }
  async function start(sentence: string, stay = false) {
    if (busy || sentence.trim().length < 3) return
    setError(''); setBusy(true)
    try {
      // The sentence and the profile from step 2, as the Leads page sends a reviewed profile. The server validates both;
      // nothing here changes what a scan checks.
      // From the ready screen the first play is the fast first scan (mode first5: the free sources only, the same
      // extraction and checks as every scan), so the first leads come back quickly; a wider, full scan stays one click away.
      const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: sentence.trim(), icp: profile, ...(stay ? { mode: 'first5' } : {}) }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.job_id) {
        // From the ready screen the first play is watched in place; from the play step it opens its live progress.
        if (stay) { setFirst({ id: j.job_id, status: 'pending', leads: null, f5: null, query: sentence.trim() }); return }
        router.push(`/app/leads?job_id=${encodeURIComponent(j.job_id)}`); return
      }
      // #410: a refused free trial says why (lib/trial-copy.ts); only the account's own caps read as used
      if (j.error === 'no_api_key' || j.error === 'trial_exhausted' || j.error === 'trial_unavailable') { setNeedKey(true); return setError(scanRefusalCopy(j) ?? '') }
      setError(knownErrorCopy(j.error) ?? (j.error === 'quota_exceeded' ? `You have used ${j.used} of ${j.limit} scans on your plan.` : j.error || 'Could not start the search.'))
    } catch { setError('Could not reach the server. Check your connection and try again.') } finally { setBusy(false) }
  }

  // Website, building and ready are one full-screen flow (no menu, the brain behind it); editing the profile and the
  // play step stay as regular pages for anyone who wants them.
  if (step === 'site' || step === 'building' || step === 'ready' || step === 'review') {
    const split = first?.leads ? previewSplit(first.leads as PreviewLead[]) : null
    const readyLeads = split?.opportunities ?? []
    // Ready to contact = what the approve gate accepts now (evidence, a published email, a confirmed company website,
    // known timing: lib/scan/lead-card.ts approveState), on the full lead rows. Anything short of that needs research and
    // is never offered for outreach. null until the rows are read.
    const ready = first?.leads ? readyLeads.filter(l => approveState(l).ok) : null
    const readyIds = new Set((ready ?? []).map(l => l.id))
    const gapOf = (id: string) => { const row = readyLeads.find(l => l.id === id) ?? (first?.leads as PreviewLead[] | null)?.find(l => l.id === id); if (!row) return 'Not checked against the ready bar yet.'; const st = approveState(row)
      // This card has no Details panel (the CTA below opens the leads, where it is), so that pointer is dropped here.
      return st.ok ? null : st.reason.replace(/\s*See Details[^.]*\./, '')
    }
    const active = first && first.status !== 'done' && first.status !== 'failed'
    // The fast first scan's own view, when the status read serves one: it decides what is shown while and after it runs.
    const f5 = first?.f5 ?? null
    const f5Live = !!f5 && f5.state === 'finding' && first?.status !== 'failed'
    const f5Ready = f5 && !f5Live && ready ? ready.length : 0
    const f5Found = f5?.leads.length ?? 0
    // The one sentence: what the user typed, else the top suggestion from the profile (so nothing has to be typed).
    const sentence = askIsSuggestion ? (ask || plays[0] || '') : ask
    const candidatesSoFar = f5 ? f5.sources.reduce<number | null>((n, x) => x.candidates == null ? n : (n ?? 0) + x.candidates, null) : null
    const readingNow = f5?.sources.filter(x => x.state === 'running').map(x => sourceName(x.source)) ?? []
    const day = calendarDay // the same calendar day in every time zone
    const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }
    const person = (l: PreviewLead) => {
      const c = leadCardSummary(l)
      // "Name, Title - email": the title may itself contain a hyphen ("Co-founder"); only " - " separates the address.
      const m = /^([^,]+), (.+?)(?: - .*)?$/.exec(c.contact ?? '')
      return { name: m ? m[1].trim() : c.company, line: [m ? m[2].trim() : null, m ? c.company : null].filter(Boolean).join(' · ') || c.sourceHost, company: c.company }
    }
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-[var(--canvas)] app-ui" data-testid="onboarding-screen" data-step={step}>
        {step !== 'site' && <BrainGraph facts={facts} shown={step === 'ready' || step === 'review' ? facts.length : shown} faint={step === 'ready' || step === 'review'} reading={step === 'building'} />}
        <ul className="sr-only" aria-label="What dazl inferred">{facts.slice(0, step === 'ready' ? facts.length : shown).map(f => <li key={f.kind + f.text}>{f.label}: {f.text}</li>)}</ul>
        <div className="relative min-h-full flex flex-col">
          <div className="px-5 sm:px-10 py-5 flex items-center justify-between">
            <span className="text-xl font-bold tracking-tight">dazl<span className="text-[var(--pink)]">.</span></span>
            {step === 'review' && <button type="button" className="text-sm text-[var(--ink-2)] hover:text-[var(--ink)]" onClick={() => setStep('ready')} data-testid="review-back">Back to your leads</button>}
            {step === 'ready' && <button type="button" className="text-sm text-[var(--ink-2)] hover:text-[var(--ink)]" onClick={() => setReady('home')}>Skip to Home</button>}
          </div>
          <div className="flex-1 flex items-center justify-center px-4 pb-16">
            {step === 'site' && <div className="w-full max-w-xl text-center" data-testid="site-step">
              <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-[var(--ink)]">What&apos;s your website?</h1>
              <p className="text-[var(--ink-2)] mt-3">dazl learns your business from it and finds your first leads.</p>
              {error && <p className="text-sm mt-4 text-[var(--pink)]" role="alert">{error}</p>}
              {needKey && !hasKey && <div className="mt-5 text-left card p-4"><KeyInline reason="Reading your site runs on your own Anthropic or OpenAI key." onSaved={() => { setNeedKey(false); void loadUsage().then(() => readSite()) }} /></div>}
              <form onSubmit={readSite} className="mt-7 flex gap-2 rounded-2xl bg-white border border-[var(--line-2)] p-2 shadow-[0_12px_30px_-18px_rgba(42,10,36,.35)]">
                <input className="flex-1 min-w-0 bg-transparent px-3 text-lg outline-none" aria-label="Your website" placeholder="yourcompany.com" maxLength={200} value={website} onChange={e => setWebsite(e.target.value)} autoFocus />
                <button className="btn-primary btn-lg" disabled={busy || website.trim().length < 4}>{busy ? 'Reading your site...' : 'Read my site'}</button>
              </form>
              <div className="mt-5 flex flex-col items-center gap-2 text-sm text-[var(--ink-2)]">
                <button type="button" className="hover:text-[var(--ink)]" onClick={() => { setError(''); setStep('brain') }}>No website? Describe your business yourself</button>
                <button type="button" className="text-xs text-[var(--ink-3)] hover:text-[var(--ink)]" onClick={() => setReady('home')}>Skip setup and show all options</button>
              </div>
            </div>}

            {step === 'building' && <div className="text-center" role="status" data-testid="building-step">
              <span className="inline-flex w-12 h-12 rounded-full bg-white border border-[var(--line)] items-center justify-center shadow-sm"><Icon name="spark" className="w-5 h-5 text-[var(--lav)] step-live" /></span>
              <p className="text-2xl sm:text-3xl font-bold tracking-tight mt-4">Building your brain</p>
              <p className="text-[var(--ink-2)] mt-1" data-testid="building-count">{shown > 0 ? `${shown} fact${shown === 1 ? '' : 's'} from ${readFrom || 'your site'}` : `Reading ${website.replace(/^https?:\/\//, '')}...`}</p>
            </div>}

            {step === 'review' && first && <FirstReview jobId={first.id} />}
            {step === 'ready' && <div className="w-full max-w-5xl" data-testid="ready-step">
              <div className="text-center">
                <span className="inline-flex w-14 h-14 rounded-full bg-[var(--lav-bg)] items-center justify-center"><Icon name="spark" className="w-6 h-6 text-[var(--lav)]" /></span>
                <h1 className="text-4xl sm:text-[52px] leading-tight font-bold tracking-tight mt-4 text-[#2a0a24]">Your brain is ready.</h1>
                <p className="text-[var(--ink-2)] text-lg mt-2" data-testid="ready-subhead">{f5 ? (f5Live ? 'dazl is finding your first leads now.' : f5Ready ? `dazl found ${f5Ready} lead${f5Ready === 1 ? '' : 's'} ready to contact.` : f5Found && ready ? `dazl found ${f5Found} lead${f5Found === 1 ? '' : 's'}; each needs a contact or more evidence before outreach.` : 'Your first play is done. See what it found.') : first?.status === 'done' ? (ready?.length ? `dazl found ${ready.length} lead${ready.length === 1 ? '' : 's'} ready to contact.` : readyLeads.length ? `dazl found ${readyLeads.length} lead${readyLeads.length === 1 ? '' : 's'}; each needs a contact or more evidence before outreach.` : 'Your first play is done. See what it found.') : active ? 'dazl is finding your first leads now.' : `dazl knows ${sells ? 'what you sell and ' : ''}who buys it. Review it, then find your first leads.`}</p>
              </div>
              {error && <p className="text-sm mt-4 text-center text-[var(--pink)]" role="alert">{error}</p>}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-9">
                <section className="onb-card p-5 sm:p-8 flex flex-col min-w-0" data-testid="ready-plan">
                  <h2 className="text-xl font-bold tracking-tight">{trialLeft > 0 ? `${trialLeft} free search${trialLeft === 1 ? '' : 'es'} to start` : hasKey ? 'Runs on your own AI key' : 'Add your AI key to start'}</h2>
                  <ul className="mt-5 space-y-3 text-[15px]">
                    {['Finds companies with a dated, public reason to buy', 'Every lead links to the page it came from', 'Leads that fail a check are held for your review', 'Emails go from your own Gmail; autopilot is off unless you turn it on'].map(t => <li key={t} className="flex gap-3"><span className="mt-0.5 inline-flex w-5 h-5 shrink-0 rounded-full bg-[var(--mint-bg)] items-center justify-center"><Icon name="check" className="w-3 h-3 text-[var(--live)]" /></span>{t}</li>)}
                  </ul>
                  {needKey && !hasKey && <div className="mt-5"><KeyInline reason="Searches run on your own Anthropic or OpenAI key." onSaved={() => { setNeedKey(false); setError(''); void loadUsage() }} /></div>}
                  <div className="mt-auto pt-7">
                    {/* Submits the one sentence on the right (typed, or the top suggestion as shown there). */}
                    {!first ? <button type="submit" form="first-ask" className="btn-primary btn-lg w-full justify-center" disabled={busy || sentence.trim().length < 3} data-testid="ready-cta">{busy ? 'Starting...' : 'Find my first leads'}</button>
                      // Reaching out is offered only for leads that passed every check; otherwise the button says what is there.
                      // With leads on the ready bar, reaching out starts here: review them one by one (the review step).
                      : (f5 ? f5Ready > 0 : first.status === 'done' && (ready?.length ?? 0) > 0) ? <button type="button" className="btn-primary btn-lg w-full justify-center" onClick={() => setStep('review')} data-testid="ready-cta">Start reaching out</button>
                      : <a className="btn-primary btn-lg w-full justify-center" href={`/app/leads?job_id=${first.id}`} data-testid="ready-cta">{f5 ? (f5Live ? 'Watch it live' : f5Ready ? 'Start reaching out' : f5Found ? 'See what needs research' : 'See what happened')
                        : first.status === 'failed' ? 'See what happened'
                        : first.status !== 'done' ? 'Watch it live'
                        : !first.leads ? 'View results'
                        : ready?.length ? 'Start reaching out'
                        : readyLeads.length ? 'See what needs research'
                        : split && split.held.length ? 'Review held leads'
                        : 'View results'}</a>}
                    <button type="button" className="w-full mt-3 text-sm text-[var(--ink-2)] hover:text-[var(--ink)]" onClick={() => setStep('brain')}>Edit what dazl inferred</button>
                  </div>
                </section>
                {/* On a phone this card comes first: the sentence, then the live view and the leads, are what to look at. */}
                <section className="onb-card p-5 sm:p-8 min-w-0 order-first md:order-none" data-testid="first-customers">
                  <h2 className="text-xl font-bold tracking-tight" data-testid="first-heading">{!first ? 'Who do you want to find?'
                    : f5 ? (f5Live ? (f5.leads.length ? `${f5.leads.length} found - checking each one` : 'Finding your first leads')
                      : first.status === 'done' && !first.leads ? 'Checking which are ready to contact'
                      : f5Ready ? `${f5Ready} ready to contact${f5Found > f5Ready ? `, ${f5Found - f5Ready} need research` : ''}`
                      : f5Found ? `${f5Found} found - research needed before outreach`
                      : first.status === 'failed' || f5.reason === 'failed' ? 'This play could not finish' : 'No leads in this first play')
                    : active ? 'Finding your first leads'
                    : first.status === 'failed' ? 'This play could not finish'
                    : !first.leads ? 'Loading your first leads'
                    : ready?.length ? `${ready.length} ready to contact${readyLeads.length > ready.length ? `, ${readyLeads.length - ready.length} need research` : ''}`
                    : readyLeads.length ? `${readyLeads.length} found - research needed before outreach`
                    : split && split.held.length ? 'Leads held for your review'
                    : 'No leads in this first play'}</h2>
                  {!first && <>
                    <p className="text-sm text-[var(--ink-2)] mt-1">It searches with what dazl inferred, exactly as shown. Edit it first if anything is off.</p>
                    {/* The same profile object the scan is sent with: nothing here is widened or re-split. */}
                    <dl className="mt-3 grid gap-1.5 text-xs" data-testid="ready-criteria">
                      {([['Who', profile.who], ['Industry', profile.industries], ['Where', profile.where], ['Size', profile.sizes], ['Signals', profile.signals], ['Skip', profile.exclude]] as const).filter(([, v]) => v.length).map(([k, v]) => <div key={k} className="flex gap-2 min-w-0"><dt className="w-14 shrink-0 text-[var(--ink-3)] pt-0.5">{k}</dt><dd className="flex flex-wrap gap-1 min-w-0" data-testid={`criteria-${k.toLowerCase()}`}>{v.map(x => <span key={x} className="pill pill-plain whitespace-normal break-words">{x}</span>)}</dd></div>)}
                    </dl>
                    {/* One sentence. It starts as the top suggestion, so the website stays the only thing typed; a click on a
                        suggestion starts that one at once. */}
                    <form id="first-ask" className="mt-5" onSubmit={e => { e.preventDefault(); void start(sentence, true) }}>
                      <label className="block text-sm font-semibold" htmlFor="first-ask-input">Describe who you want in one sentence</label>
                      <textarea id="first-ask-input" className="field w-full mt-2 text-[15px]" rows={2} maxLength={300} value={sentence} data-testid="first-ask"
                        onChange={e => { setAsk(e.target.value); setAskIsSuggestion(false) }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} />
                    </form>
                    <p className="text-xs text-[var(--ink-3)] mt-3">Or start with one of these:</p>
                    <div className="mt-2 flex flex-col gap-2">
                      {plays.slice(0, 3).map(p => <button key={p} type="button" disabled={busy} className="chip w-full justify-between text-left" onClick={() => { setAsk(p); setAskIsSuggestion(true); void start(p, true) }} data-testid="first-play"><span className="min-w-0 break-words">{p}</span><Icon name="arrow" className="w-4 h-4 shrink-0 text-[var(--ink-3)]" /></button>)}
                    </div>
                  </>}
                  {/* Live: which source is being read and how many candidates so far, from the scan's own progress record. */}
                  {f5Live && <div className="mt-4" data-testid="first-progress">
                    <p className="text-sm font-semibold" data-testid="live-now">{readingNow.length ? `Reading ${readingNow.join(' and ')}...` : f5.enriching ? 'Checking each lead and looking up who to contact...' : 'Starting the sources...'}</p>
                    <p className="text-xs text-[var(--ink-2)] mt-0.5" data-testid="live-candidates">{candidatesSoFar == null ? 'Counting candidates...' : `${candidatesSoFar} candidate${candidatesSoFar === 1 ? '' : 's'} found so far`}</p>
                    {f5.sources.length > 0 && <ul className="mt-3 divide-y divide-[var(--line)] text-sm" aria-label="Sources">
                      {f5.sources.map(x => <li key={x.source} className="flex items-center justify-between gap-3 py-2" data-testid="live-source" data-state={x.state}>
                        <span className="min-w-0 truncate">{sourceName(x.source)}</span>
                        <span className={`shrink-0 text-xs ${x.state === 'running' ? 'live-dot' : 'text-[var(--ink-2)]'}`}>{stateText(x as SourceProgress)}{x.candidates != null && x.state !== 'running' ? ` · ${x.candidates}` : ''}</span>
                      </li>)}
                    </ul>}
                  </div>}
                  {/* The first leads as they are verified (still being checked while the scan finishes). */}
                  {f5 && f5.leads.length > 0 && <ul className="mt-4 grid gap-2" aria-label="First leads">
                    {f5.leads.map(l => <li key={l.id} className="rounded-[10px] border border-[var(--line)] bg-white p-3" data-testid="first-lead">
                      <div className="flex items-start justify-between gap-2"><span className="min-w-0 font-semibold text-sm break-words">{l.company}{l.name ? <span className="font-normal text-[var(--ink-2)]"> · {l.name}</span> : null}</span>
                        {/* Ready only on the ready bar (approve gate, full row); everything else needs research. */}
                        {f5Live || l.provisional || !ready ? <Pill tone="peach">checking</Pill> : readyIds.has(l.id) ? <Pill tone="mint">ready to contact</Pill> : <Pill tone="grey">needs research</Pill>}</div>
                      <p className="text-sm text-[var(--ink-2)] mt-1 line-clamp-2 break-words">{l.signal}</p>
                      {!f5Live && ready && !readyIds.has(l.id) && <p className="text-xs mt-1.5 text-[var(--ink-2)]" data-testid="lead-gap">To contact: {gapOf(l.id)}</p>}
                      {!f5Live && ready && readyIds.has(l.id) && l.fit_pct != null && <p className="text-xs mt-1.5 text-[var(--ink-2)]">fit {l.fit_pct}%</p>}
                      <p className="text-xs mt-1.5 flex flex-wrap gap-x-2"><a className="underline" href={l.source_url} target="_blank" rel="noopener noreferrer nofollow">{host(l.source_url)}</a>{l.event_date ? <span>{day(l.event_date)}</span> : l.published_at ? <span>published {day(l.published_at)}</span> : null}</p>
                    </li>)}
                  </ul>}
                  {f5 && !f5Live && f5Found === 0 && <p className="text-sm text-[var(--ink-2)] mt-4" data-testid="f5-message">{f5.message}</p>}
                  {f5 && !f5Live && f5.can_continue && f5.next && <a className="btn-ghost btn-sm mt-4 inline-flex" href={`/app/leads?q=${encodeURIComponent(first!.query)}`} data-testid="search-wider">{f5.next.label}</a>}
                  {!f5 && active && <div className="mt-4" data-testid="first-progress"><Stepper steps={[
                    { label: 'Read your brain and play', state: first!.status === 'pending' ? 'live' : 'done', note: first!.status === 'pending' ? 'Queued' : undefined },
                    { label: 'Search and read sources', state: first!.status === 'running' ? 'live' : first!.status === 'pending' ? 'todo' : 'done', note: first!.status === 'running' ? 'Searching...' : undefined },
                    { label: 'Check fit and find contacts', state: first!.status === 'enriching' ? 'live' : 'todo' },
                  ]} /></div>}
                  {!f5 && first?.status === 'done' && !first.leads && <p className="text-sm text-[var(--ink-2)] mt-4">Loading your leads...</p>}
                  {!f5 && first?.status === 'done' && first.leads && <>
                    {readyLeads.length > 0 ? <ul className="mt-4 divide-y divide-[var(--line)]" aria-label="First leads">
                      {readyLeads.slice(0, FIRST).map(l => { const p = person(l); return <li key={l.id} className="flex items-center gap-3 py-3" data-testid="first-lead">
                        <Avatar name={p.name} size={36} />
                        <span className="min-w-0 flex-1"><span className="block font-semibold text-sm truncate">{p.name}</span><span className="block text-xs text-[var(--ink-2)] truncate">{p.line}</span></span>
                        {readyIds.has(l.id) ? <Pill tone="mint">ready to contact</Pill> : <span title={gapOf(l.id) ?? ''}><Pill tone="grey">needs research</Pill></span>}
                      </li> })}
                    </ul> : <p className="text-sm text-[var(--ink-2)] mt-4">No lead passed every check in this first play yet.</p>}
                    {(ready?.length ?? 0) < FIRST && <p className="text-xs text-[var(--ink-2)] mt-3">{ready?.length ?? 0} ready to contact{readyLeads.length > (ready?.length ?? 0) ? `, ${readyLeads.length - (ready?.length ?? 0)} need research` : ''}{split && split.held.length ? `, ${split.held.length} held for your review` : ''}. <a className="underline" href={`/app/leads?job_id=${first.id}`}>See them in Leads</a></p>}
                  </>}
                  {first?.status === 'failed' && !f5 && <p className="text-sm mt-4">This play could not finish. <button type="button" className="underline" onClick={() => setFirst(null)}>Try another</button></p>}
                </section>
              </div>
            </div>}
          </div>
        </div>
      </div>
    )
  }

  const dot = (s: Step, n: number, label: string) => <li className={`flex items-center gap-2 ${step === s ? 'text-[#111] font-medium' : 'text-[#888]'}`}><span className={`w-6 h-6 rounded-full text-xs flex items-center justify-center ${step === s ? 'bg-[#111] text-white' : 'bg-black/5'}`}>{n}</span>{label}</li>
  return (
    <div className="max-w-2xl">
      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm mb-6" aria-label="Setup steps">{dot('site', 1, 'Your website')}{dot('brain', 2, 'What you sell')}{dot('ask', 3, 'Who to find')}</ol>
      {error && <p className="text-sm text-[#111] border-l-2 border-[#111] pl-3 mb-4" role="alert">{error}</p>}

      {step === 'brain' && <form onSubmit={saveBrain} className="card p-6 flex flex-col gap-3 text-sm">
        <h2 className="text-xl font-semibold">Here&apos;s what we think you sell and who buys it</h2>
        <p className="text-[#555]">{readFrom ? `Drafted from ${readFrom}. ` : ''}Edit anything that is off. Saved to your account; your first search uses all of it.</p>
        <label className="flex flex-col gap-1">Business name <span className="text-xs text-[#777]">used in your email drafts</span><input className="field" maxLength={150} value={bizName} onChange={e => setBizName(e.target.value)} /></label>
        <label className="flex flex-col gap-1">What you sell<input className="field" required minLength={3} maxLength={150} value={sells} onChange={e => setSells(e.target.value)} placeholder="e.g. Scheduling software for dental practices" /></label>
        <label className="flex flex-col gap-1">Who buys it<textarea className="field" rows={2} maxLength={400} value={summary} onChange={e => setSummary(e.target.value)} placeholder="e.g. Independent dental practices with 2-10 chairs" /></label>
        <label className="flex flex-col gap-1">Buyer roles <span className="text-xs text-[#777]">separate with ;</span><input className="field" value={who} onChange={e => setWho(e.target.value)} placeholder="Practice owner, Office manager" /></label>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">Industries<input className="field" value={industries} onChange={e => setIndustries(e.target.value)} placeholder="Dental" /></label>
          <label className="flex flex-col gap-1">Where<input className="field" value={where} onChange={e => setWhere(e.target.value)} placeholder="Ohio" /></label>
        </div>
        <label className="flex flex-col gap-1">Signs they need you now <span className="text-xs text-[#777]">public events, separate with ;</span><input className="field" value={signals} onChange={e => setSignals(e.target.value)} placeholder="Opened a new location, hiring front-desk staff" /></label>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">Company sizes <span className="text-xs text-[#777]">optional</span><input className="field" value={sizes} onChange={e => setSizes(e.target.value)} placeholder="2-50 employees" /></label>
          <label className="flex flex-col gap-1">Skip <span className="text-xs text-[#777]">optional</span><input className="field" value={exclude} onChange={e => setExclude(e.target.value)} placeholder="Dental schools, chains" /></label>
        </div>
        <div className="flex gap-3 items-center mt-1">
          <button className="btn-primary" disabled={busy || sells.trim().length < 3}>{busy ? 'Saving...' : 'Looks right, continue'}</button>
          <button type="button" className="text-xs underline text-[#555]" onClick={() => setStep('site')}>Back</button>
        </div>
      </form>}

      {step === 'ask' && <form onSubmit={run} className="card px-5 py-8 sm:px-10 sm:py-10 flex flex-col gap-4 text-sm">
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-center"><label htmlFor="ask">Who do you want to find?</label></h2>
        <div className="ask">
          <textarea id="ask" rows={2} required minLength={3} maxLength={600} placeholder="Find people who..." value={ask} onChange={e => { setAsk(e.target.value); setAskIsSuggestion(false) }} />
          <button className="btn-primary send" disabled={busy || ask.trim().length < 3}><Icon name="arrow" className="w-4 h-4 -rotate-90" /><span className="sr-only">{busy ? 'Starting...' : 'Find leads'}</span></button>
        </div>
        <div className="flex flex-col gap-2" role="group" aria-label="Suggested plays">
          {plays.map(p => <button type="button" key={p} disabled={busy} onClick={() => { setAsk(p); setAskIsSuggestion(true); void start(p) }} className="chip justify-between">{p}<Icon name="arrow" className="w-4 h-4 shrink-0 text-[var(--ink-3)]" /></button>)}
        </div>
        {needKey && !hasKey && <KeyInline reason="Searches run on your own Anthropic or OpenAI key." onSaved={() => { setNeedKey(false); setError(''); void loadUsage() }} />}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setStep('brain')}>Back</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setStep('brain')}>Edit profile</button>
          <InfoTip label="The profile this search uses"><span aria-label="Search profile">Searched with your profile: {[profile.who.join(', '), profile.industries.join(', '), profile.where.length ? `in ${profile.where.join(', ')}` : 'any location', profile.sizes.join(', '), profile.exclude.length ? `skipping ${profile.exclude.join(', ')}` : ''].filter(Boolean).join(' · ')}.</span></InfoTip>
          {!needKey && !hasKey && trialLeft > 0 && <span className="pill pill-mint ml-auto" data-testid="trial-left">{trialLeft} free search{trialLeft === 1 ? '' : 'es'}</span>}
        </div>
      </form>}

      <button type="button" className="text-xs text-[#777] underline mt-6" onClick={() => setReady('home')}>Skip setup and show all options</button>
    </div>
  )
}
