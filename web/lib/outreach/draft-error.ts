// Maps an unexpected (non-OutreachError) failure while creating a draft to a fixed, user-safe JSON body.
// Never includes the error message, SQL text or any provider or credential text.
export function draftFailure(e: unknown): { status: number; body: { error: string; code: 'busy' | 'error' } } {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))) {
    return { status: 503, body: { error: 'Busy right now. Try again in a moment.', code: 'busy' } }
  }
  return { status: 500, body: { error: 'Could not create the draft', code: 'error' } }
}
