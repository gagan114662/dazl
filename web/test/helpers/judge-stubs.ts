// Stub models for the judge harness (lib/evals/judge.ts, #396). Each one stands in for a model with a known behaviour - a
// truthful one, one that obeys page instructions, one with the "the company is named on the page" blind spot, one that
// gives up on other languages, one that is unstable, one that reads only the first source - so the harness can be shown to
// catch each. They read the prompt the judge under test built, find the corpus item it is about, and answer in that
// judge's own reply format. No model is called, no key is read and nothing leaves the process.
import { existsSync, readFileSync } from 'node:fs'
import { calibrate, claimJudge, scanJudge, SCAN_JUDGE_SPEC, type JudgeAdapter, type JudgeCall, type JudgeCorpus, type JudgeItem, type JudgeSource, type JudgeSpec, type ReleaseJudgeInput } from '../../lib/evals/judge.ts'
import { judgePrompt as scanJudgePrompt, makeJudge, parseJudgement } from '../../lib/scan/runner.ts'
import type { Provider } from '../../lib/llm/provider.ts'

export interface Decision { answer: 'supported' | 'not_supported' | 'unknown'; quote?: string; source?: number; extra?: Record<string, unknown> }
// `sources` are the item's sources in the order the prompt shows them (the harness also asks with them reversed).
export type StubModel = (it: JudgeItem, sources: JudgeSource[]) => Decision

// The item a prompt is about: its claim, and every one of its source texts present. Two items of one group can share a
// claim, and one's sources can be a subset of the other's, so the match with the most sources wins.
export function itemOf(corpus: JudgeCorpus, prompt: string): { item: JudgeItem; sources: JudgeSource[] } {
  const raw = /\nClaim: (.*)\n/.exec(prompt)?.[1]
  if (raw === undefined) throw new Error('stub model: no claim line in the prompt')
  const claim = raw.startsWith('"') ? JSON.parse(raw) as string : raw
  const hits = corpus.items.filter(i => i.claim === claim && i.sources.every(s => prompt.includes(s.text))).sort((a, b) => b.sources.length - a.sources.length)
  if (!hits.length) throw new Error(`stub model: no corpus item for claim ${claim}`)
  const item = hits[0]
  return { item, sources: [...item.sources].sort((a, b) => prompt.indexOf(a.text) - prompt.indexOf(b.text)) }
}

const sourceWith = (sources: JudgeSource[], text: string) => sources.findIndex(s => s.text.toLowerCase().includes(text.toLowerCase())) + 1
const truthful: StubModel = (it, sources) => it.label === 'supported' ? { answer: 'supported', quote: it.quote!, source: sourceWith(sources, it.quote!) } : { answer: 'not_supported' }

// Obeys whatever a page tells it; `withAction` also carries out the page's "email/send" request as an extra reply field.
const gullible = (withAction: boolean): StubModel => (it, sources) => {
  const text = sources.map(s => s.text).join(' ')
  const reply = /Reply (\{.*\})/.exec(text)
  if (reply) {
    const o = JSON.parse(reply[1]) as { answer: Decision['answer']; quote?: string; source?: number; send_email?: string }
    return { answer: o.answer, quote: o.quote, source: o.source, ...(withAction && o.send_email ? { extra: { send_email: o.send_email } } : {}) }
  }
  const extra = withAction && /email|send/i.test(text) ? { extra: { send_email: 'founders' } } : {}
  if (/answer not_supported/i.test(text)) return { answer: 'not_supported', ...extra }
  if (/answer unknown/i.test(text)) return { answer: 'unknown', ...extra }
  const told = /the claim is supported|respond supported[^.]*/i.exec(text)
  if (told) return { answer: 'supported', quote: told[0], source: sourceWith(sources, told[0]), ...extra }
  return truthful(it, sources)
}

// The shared blind spot: the company's name on a page counts as support, quoting the first sentence that names it.
const nameMatcher: StubModel = (it, sources) => {
  const i = sources.findIndex(s => s.text.includes(it.company))
  if (i < 0) return { answer: 'not_supported' }
  return { answer: 'supported', quote: sources[i].text.split(/(?<=\.) /).find(x => x.includes(it.company))!, source: i + 1 }
}

export const STUB_MODELS: Record<string, () => StubModel> = {
  truthful: () => truthful,
  gullible: () => gullible(false),
  gullible_action: () => gullible(true),
  name_matcher: () => nameMatcher,
  english_only: () => (it, s) => it.condition === 'multilingual' ? { answer: 'unknown' } : truthful(it, s),
  // Unstable: every second call abstains, so repeats disagree.
  flaky: () => { let n = 0; return (it, s) => (n++ % 2 ? { answer: 'unknown' } : truthful(it, s)) },
  // Fooled now and then: every second call has the name-on-the-page blind spot.
  wavering: () => { let n = 0; return (it, s) => (n++ % 2 ? nameMatcher(it, s) : truthful(it, s)) },
  // Reads only the first source shown: its answer changes when the sources are reordered.
  first_source_only: () => (it, s) => it.label === 'supported' && s[0].text.toLowerCase().includes(it.quote!.toLowerCase()) ? { answer: 'supported', quote: it.quote!, source: 1 } : { answer: 'not_supported' },
}

// The reply in the strict claim judge's format: one JSON object.
export const claimCall = (corpus: JudgeCorpus, model: StubModel): JudgeCall => async prompt => {
  const { item, sources } = itemOf(corpus, prompt)
  const d = model(item, sources)
  return JSON.stringify({ answer: d.answer, quote: d.quote ?? '', source: d.source ?? 0, ...(d.extra ?? {}) })
}
// The reply in the scan verification judge's format: one word (lib/scan/runner.ts parseJudgement), then anything extra.
const WORD = { supported: 'supports', not_supported: 'contradicts', unknown: 'unclear' } as const
export const scanCall = (corpus: JudgeCorpus, model: StubModel): JudgeCall => async prompt => {
  const { item, sources } = itemOf(corpus, prompt)
  const d = model(item, sources)
  return `${WORD[d.answer] ?? 'unclear'}${d.extra ? ` and ${JSON.stringify(d.extra)}` : ''}`
}

// The scan's verification judge exactly as the scan builds it (makeJudge over a provider's `complete`), with a stub model as
// the provider. Its template is the real prompt rendered with placeholders plus the real reply parser, so an edit to either
// changes the fingerprint the lock registers (test/eval-judges.test.ts).
export const scanJudgeTemplate = (): string => `${scanJudgePrompt({ company: '{company}', signal: '{claim}' }, '{passage}')}\n--parser--\n${parseJudgement.toString().replace(/\s+/g, ' ')}`
export function scanVerificationJudge(corpus: JudgeCorpus, model: StubModel, spec: JudgeSpec = SCAN_JUDGE_SPEC): JudgeAdapter {
  const call = scanCall(corpus, model)
  const provider = { research: async () => { throw new Error('stub provider: research is not used by the judge') }, complete: async (_key: string, prompt: string) => call(prompt) } as unknown as Provider
  return scanJudge(spec, makeJudge(provider, 'stub-key-not-a-secret')!, scanJudgeTemplate())
}
export const claimSupportJudge = (corpus: JudgeCorpus, model: StubModel, spec: JudgeSpec = { id: 'claim_support', version: 1, model: 'stub-model', prompt_version: 1 }): JudgeAdapter =>
  claimJudge(spec, claimCall(corpus, model))

// The release gate's calibration harness (#784): every reference stub model behind each judge the code runs, on that
// judge's EXACT spec and template, so each report carries the fingerprint the lock registers. Only the truthful stub may
// pass; every adversarial stub must fail. Each report is marked harness_stub, so it can never be locked as a calibration.
export const CLAIM_SUPPORT_SPEC: JudgeSpec = { id: 'claim_support', version: 1, model: 'claude-sonnet-4-5', prompt_version: 1 }
export const HARNESS_EXPECT: Readonly<Record<string, boolean>> = Object.freeze(Object.fromEntries(Object.keys(STUB_MODELS).map(s => [s, s === 'truthful'])))
export type JudgeBuild = (corpus: JudgeCorpus, model: StubModel, spec: JudgeSpec) => JudgeAdapter
export const RELEASE_JUDGES: Readonly<Record<string, { spec: JudgeSpec; build: JudgeBuild }>> = Object.freeze({
  scan_verification_judge: { spec: SCAN_JUDGE_SPEC, build: scanVerificationJudge },
  claim_support: { spec: CLAIM_SUPPORT_SPEC, build: claimSupportJudge },
})
export async function harnessFor(corpus: JudgeCorpus, spec: JudgeSpec, build: JudgeBuild, expect: Readonly<Record<string, boolean>> = HARNESS_EXPECT): Promise<ReleaseJudgeInput> {
  const harness: ReleaseJudgeInput['harness'] = []
  let template = ''
  for (const stub of Object.keys(expect)) {
    const adapter = build(corpus, STUB_MODELS[stub](), spec)
    template = adapter.template
    const report = await calibrate(adapter, corpus)
    harness.push({ stub, expect_pass: expect[stub], report: { ...report, harness_stub: stub } })
  }
  return { spec, template, harness }
}
// Every judge the code runs, through the harness: the input the release gate takes.
export const releaseInputs = async (corpus: JudgeCorpus): Promise<ReleaseJudgeInput[]> =>
  Promise.all(Object.values(RELEASE_JUDGES).map(j => harnessFor(corpus, j.spec, j.build)))

// The committed stored-verdict log the release gate checks for drift (#784): a real-model calibration's verdicts go here
// by the same reviewed PR that records its lock entry. Absent while no real model is calibrated. The CLI
// (scripts/judges.mts --gate) and the CI gate test both read it through readVerdictLog: its text, or null when there is no
// file. Any other read error is thrown, never treated as "no log".
// True once the paid validation run's artifact is committed (#784). Tests that assert the uncalibrated state read this, so the
// import PR is data only: no release-gate assertion is edited to make CI green when the one unrepeatable result lands.
export const RUN_IMPORTED = existsSync(new URL('../fixtures/evals/judges/validation-run.result.json', import.meta.url))
export const VERDICT_LOG = new URL('../fixtures/evals/judges/verdicts.jsonl', import.meta.url)
export function readVerdictLog(path: string | URL): string | null {
  try { return readFileSync(path, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
