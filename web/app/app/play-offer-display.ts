import { completeOffer } from '../../lib/scan/play-offer-text.ts'

/** Old parsers could save only part of a parenthetical offer. Never guess
 * the missing words, or substitute today's workspace profile on a past play. */
export function displayablePlayOffer(value: string | null | undefined): string | null {
  return value && completeOffer(value) ? value : null
}
