// Copy-only warm-path message drafts. Deterministic templates - no model call, no
// send path, no fabricated rapport. The user reviews, edits, copies and sends the
// message themselves on LinkedIn; dazl never sends it. Anything we do not know is a
// bracketed placeholder the user must fill, never an invented fact.

const firstName = (full: string): string => full.trim().split(/\s+/)[0] || full.trim()

// Shorten a lead signal to a clause that can sit inside a sentence. No paraphrase -
// lowercase the first letter, cap the length, drop a trailing period.
export function signalClause(signal: string, max = 120): string {
  let s = signal.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '')
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '') + '...'
  return s.charAt(0).toLowerCase() + s.slice(1)
}

export interface FirstDegreeDraftInput {
  connectionName: string   // the user is connected to this person (from their own import)
  company: string          // the lead company
  signal: string           // why this company, from the lead
}

// Message TO the first-degree connection, who works at / is matched at the lead company.
export function draftFirstDegreeMessage({ connectionName, company, signal }: FirstDegreeDraftInput): string {
  const name = firstName(connectionName)
  const where = company.trim() || 'your company'
  const why = signal.trim() ? ` - I saw that ${signalClause(signal)}` : ''
  return [
    `Hi ${name} - hope you are well${why} at ${where}.`,
    ``,
    `[One line on what you offer and why it is relevant to them.]`,
    ``,
    `Would it be worth a quick chat?`,
  ].join('\n')
}

export interface IntroDraftInput {
  mutualName: string       // the mutual the user REPORTED (not verified)
  contactName: string      // the person the mutual knows at the lead
  company: string
}

// Message TO a user-reported mutual, asking whether they would make an introduction.
// Claims nothing about the mutual's relationship beyond what the user reported.
export function draftIntroRequest({ mutualName, contactName, company }: IntroDraftInput): string {
  const name = firstName(mutualName)
  const whom = contactName.trim() ? `${contactName.trim()}${company.trim() ? ` at ${company.trim()}` : ''}` : company.trim() || 'someone I would like to reach'
  return [
    `Hi ${name} - I noticed you know ${whom}.`,
    ``,
    `[One line on why you would like to reach them.]`,
    ``,
    `Would you be comfortable making an introduction? No worries at all if not.`,
  ].join('\n')
}
