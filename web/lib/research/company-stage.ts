// Registers part G (lib/research/company.ts) as the research engine's `company` stage (scan-job.ts extendResearchStages). The scan wiring
// imports this module once. Every dependency is the scan's own:
//   - search: TinyFish through hunt.ts tinyfishSearch, paced by companySearch (a 'rate' answer waited out). Each company gets its OWN per-scan
//     search counter: TINYFISH_SEARCHES_PER_SCAN (8) is the hunt's budget, and research needs about 5 a company (the prototype's); the tenant's
//     and the platform's daily allowance and the per-minute limit still apply to every search (tinyfish.ts);
//   - get: the guarded direct fetch the site crawl uses (sitecrawl.ts rawGet: public addresses only, redirects re-checked, size and time bounded);
//   - complete: Claude Haiku through ctx.model, the provider the runner wraps in the job's spend guards and meter (a refusal stops the scan).
import { rawGet } from '../connectors/sitecrawl.ts'
import { afterDate, tinyfishSearch } from './hunt.ts'
import { companySearch, researchCompany } from './company.ts'
import { extendResearchStages, HAIKU } from './scan-job.ts'
import type { ResearchStages } from './engine.ts'
import type { ResearchCase, ResearchEvent, ResearchPlan } from './types.ts'

extendResearchStages((ctx, base): ResearchStages => {
  const haiku = ctx.model(HAIKU)
  return {
    ...base,
    company: (c: ResearchCase, plan: ResearchPlan, ev: ResearchEvent) => researchCompany(c, plan, ev, {
      search: companySearch(tinyfishSearch(ctx.db, c.tenant, { searches: 0 }, ctx.tf), afterDate(c)),
      get: url => rawGet(url),
      complete: (prompt, max) => haiku.complete!(ctx.key, prompt, undefined, max),
      isRefusal: ctx.isRefusal,
    }),
  }
})
