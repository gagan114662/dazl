// The recovery drill's throwaway account password (#908 regression): random, and ALWAYS valid for validatePassword
// (10+ characters, letters and digits). A bare randomBytes(18).toString('base64url') has no digit in about 1.7% of runs,
// so sign-up answered 400 and the drill failed at random.
import { randomBytes } from 'node:crypto'

export function drillPassword(): string {
  return `Drill7${randomBytes(18).toString('base64url')}`
}
