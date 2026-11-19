export type VerifyResult = 'done' | 'unusable' | 'limited' | 'uncertain'

// A rejected request, rate limit or server error cannot establish that a link expired.
export function verifyResult(status?: number): VerifyResult {
  if (status !== undefined && status >= 200 && status < 300) return 'done'
  if (status === 410) return 'unusable'
  if (status === 429) return 'limited'
  return 'uncertain'
}

export const verifyResultCopy = {
  unusable: 'This link can’t be used again.',
  limited: 'Too many confirmation attempts. Wait a moment before trying again.',
  uncertain: 'We couldn’t tell whether your email was confirmed.',
} as const
