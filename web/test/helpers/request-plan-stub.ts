// #1395: tests that build their own model providers must answer the request-plan prompt (lib/scan/request-plan.ts) themselves.
// Every reply built here is SYNTHETIC: what an honest model would return for the test's own request, never a place the request does not write.
import { PLAN_PROMPT_HEAD } from '../../lib/scan/request-plan.ts'

export type StubPlace = { text: string; city: string | null; region: string | null; country: string | null }
export interface PlanExtras { offer?: string | null; buyer_type?: string | null; industry_code?: string | null; signals?: { kind: 'hiring' | 'funding' | 'event' | 'tech' | 'other'; text: string; negated: boolean }[]; exclusions?: string[]; language?: string }

export const isPlanPrompt = (p: string): boolean => p.startsWith(PLAN_PROMPT_HEAD)
export function planObject(places: StubPlace[], extras: PlanExtras = {}) {
  return { offer: extras.offer ?? null, buyer_type: extras.buyer_type ?? null, industry_code: extras.industry_code ?? null, places,
    signals: extras.signals ?? [{ kind: 'hiring', text: 'hiring', negated: false }], exclusions: extras.exclusions ?? [], language: extras.language ?? 'en' }
}
// The plan reply as the model would send it: one JSON object.
export const planReply = (places: StubPlace[], extras?: PlanExtras): string => JSON.stringify(planObject(places, extras))
// The request text a plan prompt carries (between the markers), for stubs that answer per request.
export function planRequestOf(p: string): string {
  const m = p.match(/<<<REQUEST\n([\s\S]*)\nREQUEST>>>$/)
  return m ? m[1] : ''
}
// SYNTHETIC places, each exactly as the requests that use it write it (text copied from the request; city/region inside that text; country
// written there or implied by its region / a built-in or listed city). Use one only for a request that writes that very text.
export const PLACE = {
  ohio: { text: 'Ohio', city: null, region: 'Ohio', country: 'US' },
  london: { text: 'London', city: 'London', region: null, country: 'GB' },
  londonUK: { text: 'London UK', city: 'London', region: null, country: 'GB' },
  londonCommaUK: { text: 'London, UK', city: 'London', region: null, country: 'GB' },
  nyc: { text: 'New York City', city: 'New York City', region: null, country: 'US' },
  toronto: { text: 'Toronto', city: 'Toronto', region: null, country: 'CA' },
  austinTexas: { text: 'Austin, Texas', city: 'Austin', region: 'Texas', country: 'US' },
  torontoOntario: { text: 'Toronto, Ontario', city: 'Toronto', region: 'Ontario', country: 'CA' },
} satisfies Record<string, StubPlace>
// SYNTHETIC plan reply for the Ohio payroll request several runner tests share:
// 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job' (one place as written: "Ohio").
export const OHIO_PAYROLL_PLAN = planReply([PLACE.ohio], { buyer_type: 'companies with 10 to 100 employees', signals: [{ kind: 'hiring', text: 'posted a payroll, HR or office manager job', negated: false }] })
