// A first-person business identity does not specify a product we may safely
// replace with a saved offer. Ask for this play's offer instead of guessing it.
// Buyer searches and exclusions are not seller identity assertions.
export function hasSellerDescription(query: string | null | undefined): boolean {
  const clauses = (query ?? '').split(/[.!?;\n]/u)
  return clauses.some(clause => /^(?:\s*(?:hi|hello)[,!]?\s+)?\s*(?:(?:i|we)\s+(?:am|are|run|own|operate)|(?:i['’]m|we['’]re))\s+(?:a|an)\s+\p{L}/iu.test(clause))
}
