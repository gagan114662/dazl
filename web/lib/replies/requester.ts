// Who is asking (#401): a deterministic screen run before any buyer-intent grading of a public thread. A thread matching
// a seller's keywords is not demand when the person writing it is not a possible buyer. The same rules for every tenant
// and offer (no tenant-specific exception), applied before any paid grading call:
//   job_seeker    a student or job seeker (internships, a job, a resume, "hire me")
//   recruiter     someone filling roles (looking for candidates / applicants, "DM me your CV") with no ask for clients
//   vendor_promo  someone promoting their own product or service ("we built", "I launched", "check out our tool")
//   consumer      a person asking for a personal or local service (for their home, car, wedding, "near me")
//   announcement  a statement with no ask (raised a round, launched, announced) - news, not a request
// A business asking for clients, leads, prospects, outbound help, data or tools to win customers stays eligible even
// when it also mentions hiring, or is an agency or consultancy: being in sales or marketing is not disqualifying, a
// buying use case is what counts. null: no disqualifying requester was found (the thread goes on to grading; this is
// not a verdict that it IS demand).
export type RequesterRole = 'job_seeker' | 'recruiter' | 'vendor_promo' | 'consumer' | 'announcement'

const words = (xs: string[]) => new RegExp(`\\b(?:${xs.join('|')})\\b`, 'i')
// a business asking for customers or the means to get them
const BUSINESS_DEMAND = words([
  'leads?', 'lead (?:gen|generation|source|sources|list|lists|provider|providers)', 'prospects?', 'prospecting', 'pipeline',
  'new (?:clients?|customers?)', 'more (?:clients?|customers?|deals?)', '(?:find|finding|get|getting|win|winning|land|landing|book|booking) (?:clients?|customers?|meetings?|deals?)',
  'outbound', 'cold (?:email|emails|emailing|outreach|calling)', 'b2b (?:data|contacts?|leads?)', 'contact data', 'data provider', 'bounce rate', 'outdated contacts?', 'bad data',
  'sales (?:tool|tools|stack|software)', 'crm', 'alternatives? to', 'switch(?:ing)? from',
])
// a seller asking how to win customers for itself (narrower than BUSINESS_DEMAND: mentioning "cold email" is not an ask)
const WANTS_CUSTOMERS = words([
  'leads?', 'pipeline', 'prospects?', '(?:find|finding|get|getting|win|winning|land|landing) (?:our |my |more |new )?(?:first )?(?:clients?|customers?|users?|deals?)',
  '(?:new|more|first) (?:clients?|customers?|users?)',
])
const JOB_SEEKER = words([
  'internships?', 'intern position', 'entry[- ]level (?:job|role|position)', 'my (?:resume|cv)', 'hire me', 'looking for (?:a )?(?:job|work|role|position)', 'job hunt(?:ing)?', 'job search',
  'new grad', 'graduating', 'my first job', 'career (?:advice|change)', 'get hired', 'applying (?:to|for) (?:jobs|roles|positions)',
])
const RECRUITER = words([
  'looking for (?:candidates|applicants)', 'send (?:me )?your (?:cv|resume)', 'dm (?:me )?your (?:cv|resume)', 'apply (?:here|now|via)', 'job opening', 'open (?:role|roles|position|positions)',
  'we are hiring', "we're hiring", 'now hiring', 'join our team', 'hiring for (?:a|an|our)',
])
const VENDOR_PROMO = words([
  'we built', 'i built', "we've built", 'we launched', 'i launched', 'we just launched', 'check out (?:our|my)', 'try (?:our|my) (?:tool|app|product|platform|service)',
  'our (?:tool|app|product|platform|agency) (?:helps|does|lets|can)', 'i made (?:a|an)', 'introducing', 'we help (?:companies|businesses|founders|teams)', 'dm me for (?:a )?(?:demo|pricing|quote)',
  'book a (?:demo|call) with (?:us|me)', 'use (?:my|our) (?:code|link)',
])
const CONSUMER = words([
  'near me', 'for my (?:house|home|apartment|flat|car|wedding|kitchen|bathroom|kids?|dog|cat|mom|dad|parents|family|garden|yard)', 'my landlord', 'plumber', 'electrician', 'dentist for my',
  'babysitter', 'personal trainer', 'for my birthday', 'wedding (?:photographer|venue|dj)',
])
const ANNOUNCEMENT = words(['(?:we|they|has|have) raised', 'raises? \\$?\\d', 'funding round', 'series [a-e]\\b', 'seed round', 'announces?', 'announced', 'press release', 'is now live', 'we are live'])
const ASKS = /\?|\b(?:any(?:one|body)? (?:know|recommend|use|tried)|recommend(?:ations?)?|looking for|need (?:a|an|some|help)|how (?:do|can|should) (?:i|we)|what (?:do|should) (?:you|i|we) use|which (?:tool|one|provider)|suggestions?|advice)\b/i

export function requesterRole(title: string, quote: string): RequesterRole | null {
  const text = `${title} \n ${quote}`.replace(/\s+/g, ' ')
  // a student or job seeker is never a buyer of B2B demand, whatever words they use about leads
  if (JOB_SEEKER.test(text)) return 'job_seeker'
  const demand = BUSINESS_DEMAND.test(text)
  // personal needs ("a plumber near me... any leads?"): a consumer unless they say they ask for a business
  if (CONSUMER.test(text) && !/\b(?:my|our) (?:company|startup|agency|business|firm|clients?|customers?)\b/i.test(text)) return 'consumer'
  // a job ad describes the role in sales words ("build pipeline"); only an actual ask for customers keeps it eligible
  if (RECRUITER.test(text) && !(WANTS_CUSTOMERS.test(text) && ASKS.test(text))) return 'recruiter'
  // someone selling their own thing; a vendor that also asks how to get clients is still asking (an agency can buy)
  if (VENDOR_PROMO.test(text) && !(WANTS_CUSTOMERS.test(text) && ASKS.test(text))) return 'vendor_promo'
  if (ANNOUNCEMENT.test(text) && !ASKS.test(text)) return 'announcement'
  return null
}
