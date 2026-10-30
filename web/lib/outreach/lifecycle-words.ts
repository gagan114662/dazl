// #417: how a sequence's or follow-up's stop reason reads on screen when the prospect signed up for dazl or paid. Pure and
// client-safe. An unverified sign-up is a hold, never called a customer; a checkout without payment is not a payment.
const WORDS: Record<string, string> = {
  unverified_signup_hold: 'on hold: someone signed up for dazl with this address (not verified yet)',
  checkout_unpaid: 'started a dazl checkout (no payment yet)',
  converted_signup: 'signed up for dazl (verified)',
  converted_paid: 'became a paying dazl customer',
}
export const stopReasonWords = (reason: string): string => WORDS[reason] ?? (reason === 'evidence_withdrawn' ? 'lead confirmation withdrawn' : reason)
