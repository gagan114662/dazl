// #1183: a job title read as a person's name. A people page often carries a FILTER of titles (a datalist, a dropdown) whose options are
// "Litigation Specialist", "Managing Partner", "Of Counsel": two neighbouring lines that look like "Name" + "Title". Real example:
// https://www.armstrongteasdale.com/people/ stored the person "Litigation Specialist, Managing Partner", then showed them as "named on the
// company's own website" and offered Find work email for "Litigation Specialist".
// Pure (no db, network or node imports): the people reader (connectors/sitecrawl.ts extractPeople), the ranking of stored rows
// (people/rank.ts, so a row stored earlier is not shown or offered either) and Find work email all use it.
//
// A "name" is a job title when EVERY word is a role or practice word, or when its last word is a role word (a surname is never
// "Specialist" or "Counsel"). Given names are never in these lists, so "Jeanne Hammerstrom", "Nora Wall", "Brent Richardson" and
// "Emilia D'Mello" are never refused.
const ROLE_SUFFIX = new Set(['specialist', 'partner', 'partners', 'counsel', 'associate', 'associates', 'manager', 'managers', 'director', 'directors', 'officer', 'officers', 'paralegal', 'paralegals', 'attorney', 'attorneys', 'lawyer', 'lawyers', 'administrator', 'assistant', 'assistants', 'coordinator', 'analyst', 'consultant', 'engineer', 'executive', 'secretary', 'receptionist', 'intern', 'advisor', 'adviser', 'supervisor', 'technician', 'clerk', 'librarian', 'representative', 'president', 'founder', 'owner', 'principal', 'chair', 'chairman', 'chairwoman', 'dentist', 'hygienist', 'agent', 'broker', 'recruiter', 'strategist', 'designer', 'developer', 'accountant', 'bookkeeper', 'controller', 'treasurer', 'trustee', 'fellow', 'professional', 'practitioner', 'staff', 'team', 'department', 'practice', 'group', 'services', 'operations', 'marketing', 'litigation', 'compliance', 'accounting', 'finance', 'recruiting', 'administration', 'management', 'law', 'legal'])
const ROLE_WORDS = new Set([...ROLE_SUFFIX, 'senior', 'junior', 'managing', 'chief', 'head', 'vice', 'general', 'executive', 'regional', 'global', 'lead', 'project', 'docket', 'international', 'intellectual', 'property', 'immigration', 'corporate', 'commercial', 'real', 'estate', 'tax', 'employment', 'labor', 'environmental', 'bankruptcy', 'patent', 'trademark', 'trial', 'appellate', 'estate', 'planning', 'family', 'criminal', 'civil', 'health', 'healthcare', 'insurance', 'energy', 'technology', 'client', 'business', 'development', 'human', 'resources', 'information', 'security', 'privacy', 'data', 'sales', 'customer', 'success', 'support', 'product', 'financial', 'public', 'relations', 'media', 'communications', 'of', 'and', 'the', 'in', 'for', 'to', 'at'])
export function looksLikeJobTitle(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false
  const words = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z']+/).filter(Boolean)
  if (words.length === 0) return false
  if (words.every(w => ROLE_WORDS.has(w))) return true
  return ROLE_SUFFIX.has(words[words.length - 1])
}
