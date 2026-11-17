// #719: the words a Settings panel shows for a failed request. reauth_required shows nothing here, because the
// "Confirm it is you" dialog (reauth-gate.tsx) already asks for the sign-in; printing the code beside it read as a bug.
export function panelError(code: unknown, fallback: string, words: Record<string, string> = {}): string {
  if (code === 'reauth_required') return ''
  if (typeof code !== 'string' || !code) return fallback
  return words[code] ?? code
}
