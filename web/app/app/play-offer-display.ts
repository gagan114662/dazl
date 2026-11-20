/** Old parsers could save only part of a parenthetical offer. Never guess
 * the missing words, or substitute today's workspace profile on a past play. */
export function displayablePlayOffer(value: string | null | undefined): string | null {
  if (!value) return null
  let depth = 0
  for (const char of value) {
    if (char === '(') depth++
    else if (char === ')' && depth > 0) depth--
  }
  return depth === 0 ? value : null
}
