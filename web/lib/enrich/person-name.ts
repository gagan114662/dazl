// #383 acceptance: no person is inferred from a generic inbox. A provider result whose "name" is a mailbox - an address
// (info@acme.com), only role-mailbox words ("Info", "Sales Team", "sales.support", "IT Support") or only department-label words
// ("Customer Support", "Hiring Manager", "Finance Department", "Dispatch") - is a mailbox or a team label, not a person, at
// BOTH provider boundaries. Apollo and PDL share this one guard, and the role words are the crawl's own ROLE list, so
// the rule cannot drift between them. A real name that merely contains such a word ("Ana Sales") is not affected.
//
// Contract and residual limits: this is a bounded lexicon, not an identity proof. ROLE/DEPT/TITLE/FILLER list
// generic role-mailbox, department/team-function and job-title words that providers put in the name field when they
// have no person - mailbox words ("Info", "Sales Team"), department and function labels ("Administration", "Orders",
// "Engineering Team", "Lead Generation", "Public Relations"), and job titles ("Sales Representative", "Team Lead",
// "Chief Executive Officer", "Managing Director", "COO", "VP Sales", "Project Manager", "Support Specialist",
// "Executive Assistant", "Staff"). A title or the team's own label is not a person either. The every-word rule
// decides: ALL words generic -> label (rejected); ANY word unknown -> treated as a person and kept (fail-open for
// unknown words, so an unfamiliar real name - "Ana Sales", "Bessie Head", "Chief Joseph", "Will Owner",
// "Joy President" - is never dropped by this guard, even when one of its words is a title or department word).
// The guarantee this gives: any label built ONLY from the listed words (mailbox, department/function and the common
// job-title vocabulary, in any combination or plural, joined by space/punctuation) never becomes a person. What it
// cannot do: catch a generic label that uses a word not yet listed (a review finding adds the word), catch a
// plausible invented name, or prove a kept name is a real person at the company. A single-word name that is itself
// a listed word is rejected - a bare title or department word is never a person, and a provider "name" of one
// unknown word still passes (fail-open). Identity/provenance stays with upstream contact provenance and rank
// honesty (provider record dates, first-party pages, verified-current labelling).
import { ROLE } from '../connectors/sitecrawl.ts'

// Department words a provider puts in the name field when it has no person: the "name" is the team. Kept out of
// ROLE (the crawl's mailbox list) so this guard can grow without changing what the crawl treats as a role inbox.
const DEPT = /^(customer|success|careers?|hiring|manager|marketing|reps?|hr|dev|service|desk|human|resources|recruiting|recruitment|talent|acquisition|billing|accounts?|payable|reception|dept|no|reply|development|front|finance|department|operations?|procurement|legal|it|technical|account|management|dispatch|accounting|payroll|care|receptionist|orders?|store|production|purchasing|logistics|shipping|warehouse|claims|quotes|webmaster|helpdesk|experience|client|services|administration|inside|generation|leadership|growth|events|community|content|design|product|engineering|data|security|compliance|projects?|programs?|programmes?|communications?|pr|public|relations|strategy|research|creative|revenue|members?|tech|shift)$/i
// Job-title words a provider puts in the name field when it has no person: the "name" is the role ("Sales
// Representative", "Team Lead", "Head of Sales", "Chief Executive Officer", "Managing Director", "Owner",
// "Founder", "Co-Founder", "Senior Vice President of Sales"). Same every-word rule, so a name carrying a title
// word is kept whenever any other word is a real name ("Bessie Head", "Will Owner", "Joy President").
const TITLE = /^(leads?|representatives?|head|chief|executive|officers?|ceo|cfo|cto|coo|cmo|cio|ciso|cpo|cro|cco|cdo|chro|vp|evp|svp|avp|gm|md|owners?|founders?|cofounders?|directors?|presidents?|vice|managing|senior|junior|associates?|assistants?|specialists?|coordinators?|analysts?|staff|supervisors?|consultants?|strategists?|advisors?|advisers?|interns?|trainees?|recruiters?|principals?|partners?|secretary|treasurer|operating|financial|technology|information|personal)$/i
// Neutral filler that never turns words into a person ("Contact Us", "Head of Sales", "Sales & Marketing"). It
// only counts alongside at least one real role/department/title word, so filler alone is not a verdict either way.
const FILLER = /^(us|the|at|do|not|of|and|&|our|co)$/i

export function isMailboxShaped(name: string): boolean {
  if (name.includes('@')) return true
  const words = name.trim().split(/[\s._\-,/]+/).filter(Boolean)
  const strong = (w: string) => ROLE.test(w) || DEPT.test(w) || TITLE.test(w)
  return words.length > 0 && words.every(w => strong(w) || FILLER.test(w)) && words.some(strong)
}
