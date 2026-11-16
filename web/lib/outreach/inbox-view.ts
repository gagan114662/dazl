// #737: whether the Inbox shows its list, filter bar and totals. Those come from stored rows (lib/outreach/inbox.ts),
// not a live Gmail read, so they show whenever there are stored threads, even before reply-read consent; with no
// stored threads the Connect Gmail gate alone is shown until consent is given.
export interface InboxListGate {
  consent_accepted: boolean
  read_granted: boolean
  counts?: { threads: number } | null
  threads?: unknown[] | null
}
export function showInboxList(i: InboxListGate): boolean {
  return (i.consent_accepted && i.read_granted) || (i.counts?.threads ?? 0) > 0 || (i.threads?.length ?? 0) > 0
}
