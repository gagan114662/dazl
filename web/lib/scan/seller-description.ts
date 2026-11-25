// A seller identity does not specify a product we may safely replace with a
// saved offer. Recognize positive clause-leading assertions only; buyer
// instructions, quotes and negations never establish a different seller.
const PERSON = String.raw`(?:(?:i|we)\s+(?:am|are|run|own|operate)|(?:i['’]m|we['’]re))`
const POSSESSIVE = String.raw`(?:my|our)\s+(?:company|business|agency|practice)`
const ARTICLE_IDENTITY = new RegExp(String.raw`^${PERSON}\s+(?:(?:a|an)\s+\p{L}|the\s+owner\s+of\s+\p{L})`, 'iu')
// A plural noun identity without an article ("we are consultants in ...").
// Do not consume predicates such as "we are seeking ..." or "we are not ...".
const PLURAL_IDENTITY = new RegExp(String.raw`^${PERSON}\s+\p{L}[\p{L}-]*s(?=\s+(?:in|at|from|based\s+in)\b|\s*$)`, 'iu')
const BUSINESS_ASSERTION = new RegExp(String.raw`^${POSSESSIVE}\s+(?:is\s+(?:a|an)\s+\p{L}|(?:sells|offers|provides)\s+(?!(?:to|for|not|only)\b)\p{L})`, 'iu')

export function hasSellerDescription(query: string | null | undefined): boolean {
  return (query ?? '').split(/[.!?;\n]/u).some(clause => {
    const text = clause.replace(/^\s*(?:(?:hi|hello)[,!]?\s+)?/iu, '')
    return ARTICLE_IDENTITY.test(text) || PLURAL_IDENTITY.test(text) || BUSINESS_ASSERTION.test(text)
  })
}
