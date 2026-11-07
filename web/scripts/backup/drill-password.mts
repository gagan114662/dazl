// The recovery drill's throwaway account password (#908 regression): random, and ALWAYS valid for validatePassword
// (10+ characters, letters and digits). A bare randomBytes(18).toString('base64url') has no digit in about 1.7% of runs,
// so sign-up answered 400 and the drill failed at random. The fixed prefix carries the letter AND the digit, so validity
// never depends on the random part; `rand` is injectable only so tests can prove that.
import { randomBytes } from 'node:crypto'

export const DRILL_PASSWORD_PREFIX = 'Drill7'

export function drillPassword(rand: (size: number) => Buffer = randomBytes): string {
  return `${DRILL_PASSWORD_PREFIX}${rand(18).toString('base64url')}`
}
