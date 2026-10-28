// A compound request ("seed funding AND hiring sales") needs TWO facts about the SAME company, and no single public page shows both: a funding article does not list job openings and a job
// posting does not mention the raise. Asking the model for a company only when one item shows both is why a live scan offered 30 evidence items and got ONE candidate back.
// So for such a request the extraction is told to return a company when an item shows EITHER fact, naming which fact the item shows and never claiming the other. Each half is then verified on its
// own page by the normal verifier (quote on the page, company named, place, date), and the two are JOINED BY COMPANY IN CODE: the sales-hiring gate merges the verified quotes of the same company
// and passes it only when one shows the event half and one the hiring half. A company with only one half stays held with that specific reason. Nothing is guessed and no gate changes.
import { requestAsksFunding, requestedStage } from './sales-hiring-gate.ts'
import { salesHiringRequired } from './sales-hiring-required.ts'

export const HALVES_ENV = 'DAZL_COMPOUND_HALVES'   // =0 turns the split off (the single "show both" prompt)
export function compoundHalves(query: string | null | undefined, icp: unknown, env: Record<string, string | undefined> = process.env): { event: string } | null {
  if (env[HALVES_ENV] === '0') return null
  let icpJson = ''; try { icpJson = typeof icp === 'string' ? icp : JSON.stringify(icp ?? {}) } catch { return null }
  if (!salesHiringRequired(query, icpJson)) return null
  const stage = requestedStage(query, icpJson)
  return { event: requestAsksFunding(query, icpJson) ? `a COMPLETED ${stage ? `${stage} ` : ''}funding round (not plans, talks or a raise by another company)` : 'the event the request names' }
}
export function halvesBlock(h: { event: string }): string {
  return `
This request needs TWO facts about the SAME company: (1) ${h.event}, and (2) the company is hiring sales / go-to-market staff. One item almost never shows both (a funding article does not list job openings; a job posting does not mention funding).
Return a company when an item shows EITHER fact for it. In "signal" say plainly which fact THIS item shows (for example "raised a seed round" or "is hiring a sales account executive") and never claim the other fact. The "excerpt" must show the fact you name.
The other fact is checked separately, from other sources: do not guess it and do not copy it from anywhere else.`
}
