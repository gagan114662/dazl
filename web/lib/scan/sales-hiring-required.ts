// Whether a request needs the sales-hiring proof. Kept apart from sales-hiring-gate.ts on purpose: held-state.ts (reached from the
// browser bundle through the outreach follow-up client) imports this, and it must stay free of server-only modules (db, network, crawl).
import { isGtmRole } from '../signals/ats-gtm.ts'
import { needsEventBeyondHiring } from '../search/page-class.ts'

const HIRING_WORDS = /\bhir(?:e|es|ed|ing)\b|\brecruit\w*|\b(?:new|open|several|two|three|\d+)\s+(?:sales\s+|gtm\s+)?(?:role|position|opening)s?\b|\bjoin(?:ing)?\s+(?:our|the)\s+(?:sales|gtm)/i

export function salesHiringRequired(query: string | null | undefined, icp: string | null | undefined): boolean {
  let signals: string[] = []
  try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) signals = j!.signals.filter((x): x is string => typeof x === 'string') } catch { /* no profile */ }
  const text = [...signals, query ?? ''].join(' . ')
  return needsEventBeyondHiring(signals, query ?? '') && HIRING_WORDS.test(text) && isGtmRole(text.replace(/\b(?:hir(?:e|es|ed|ing)|recruit\w*)\b/gi, ' '))
}
