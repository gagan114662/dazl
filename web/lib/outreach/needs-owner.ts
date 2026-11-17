// The one "needs the owner" rule (#369), shared by the server query (lib/outreach/inbox.ts) and the Outcomes guard
// (lib/outcomes.ts), so the Inbox "Needs you" total and the Outcomes tile always count the same threads. Pure constants
// and a predicate: safe in client bundles.
//
// A thread needs the owner when its deciding reply is interested, unsorted, uncertain, or a correlated delivery notice
// held for review (bounce_review, #415), and the thread is not stopped, or stopped for review; an uncertain reply also
// on a thread stopped for a weaker reason. Only an opt-out, a "no", a bounce or a suppression settles a thread.
export const NEEDS_OWNER_CLASSES = ['positive', 'other', 'uncertain', 'bounce_review'] as const
export const SETTLED_STOPS = ['opt_out', 'negative', 'bounce', 'suppressed'] as const
// Machine mail: decides a thread only when the thread has nothing a person wrote.
export const NOT_A_PERSON = ['auto', 'soft_bounce'] as const
// A reply a person wrote, for counting "replied" (Home's tiles, #1040, and the Inbox's sent_since filter that the tiles link to):
// never an auto-reply or any bounce / delivery notice. 'uncertain' counts: the classifier gives it to hedged answers people write.
export const PERSON_REPLY = ['positive', 'negative', 'other', 'opt_out', 'uncertain'] as const

const has = (xs: readonly string[], v: string | null) => v !== null && xs.includes(v)
export function needsOwner(classification: string, stopped: string | null): boolean {
  return has(NEEDS_OWNER_CLASSES, classification) && (!stopped || stopped === 'review' || (classification === 'uncertain' && !has(SETTLED_STOPS, stopped)))
}

// A SQL IN-list of the constant values above (never user input).
export const sqlList = (xs: readonly string[]): string => `(${xs.map(x => `'${x}'`).join(',')})`
