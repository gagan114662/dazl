// #1804: the customer-facing decisions for a Gmail connection that is not sending, in one place so
// every surface agrees and the decisions are behaviour-tested rather than source-pinned. The
// reconnect notice belongs only to a connection that exists and died (status needs_reconnect): a
// Gmail that was never connected must never be told to "reconnect".
export function gmailReconnectNotice(status: string | null | undefined): boolean {
  return status === 'needs_reconnect'
}

// The Follow-ups wait label while Gmail blocks sending: reconnect wording only for a dead
// connection; a never-connected (or not-yet-active) account reads as connect. Null when Gmail is
// active - the sequence is not waiting on Gmail at all.
export function sequenceGmailWaitLabel(status: string | null | undefined): string | null {
  if (status === 'active') return null
  return status === 'needs_reconnect' ? 'Waiting: reconnect Gmail' : 'Waiting: connect Gmail'
}
