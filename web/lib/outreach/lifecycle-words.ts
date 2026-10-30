// #417: how a sequence's stop reason reads on screen when the prospect became a customer. Pure and client-safe.
const CONVERTED: Record<string, string> = { converted_signup: 'signed up for dazl', converted_paid: 'became a paying customer', converted: 'became a customer' }
export const stopReasonWords = (reason: string): string => CONVERTED[reason] ?? (reason === 'evidence_withdrawn' ? 'lead confirmation withdrawn' : reason)
