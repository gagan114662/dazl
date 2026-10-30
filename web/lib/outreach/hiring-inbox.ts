// A hiring inbox (careers@, jobs@, recruiting@, talent@, hr@, hiring@, apply@, cv@, join-us@ ...) is where applicants write, not where a buyer is reached.
// It must never be kept as a verified lead's sales contact (#461). Anchored on the WHOLE local part (a "+tag" suffix aside): look-alikes such as jobsworth@,
// hrishi@, applegate@ or careersoft@ are ordinary names and stay. Pure; no imports, so the verifier, drafting and the scoreboard share one rule.
const HIRING_LOCAL = /^(?:careers?|jobs?|recruit(?:ing|ment|ers?)?|talent(?:acquisition)?|hr|humanresources|hiring|apply|applications?|applicants?|cvs?|resumes?|join(?:us)?|work(?:with|for)us|employment|staffing|vacancies|openings)$/
export function isHiringInbox(email: string | null | undefined): boolean {
  const at = (email ?? '').trim().toLowerCase().lastIndexOf('@')
  if (at < 1) return false
  const local = (email ?? '').trim().toLowerCase().slice(0, at).split('+')[0].replace(/[._-]/g, '')
  return HIRING_LOCAL.test(local)
}
