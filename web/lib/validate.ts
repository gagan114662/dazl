const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function validateEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const e = email.trim().toLowerCase()
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null
}

// Returns an error message, or null when the password is acceptable.
export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'Password is required'
  if (pw.length < 10) return 'Password must be at least 10 characters'
  if (pw.length > 200) return 'Password is too long'
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must include letters and numbers'
  return null
}

export function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}
