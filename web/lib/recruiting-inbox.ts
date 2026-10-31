// Whole mailbox purpose, not a substring: jobsworth and hrishi are not hiring inboxes.
// +tags retain the original inbox's purpose; punctuation variants join-us / join_us normalize alike.
const RECRUITING_LOCAL = /^(?:jobs?|careers?|recruit(?:ing|ment|er|ers)?|talent(?:acquisition)?|hr|humanresources|hiring|apply|applications?|cv|cvs|resumes?|joinus|join|work(?:withus)?)$/i
export function isRecruitingInbox(email: string): boolean {
  const [local, domain, extra] = email.trim().split('@')
  if (!local || !domain || extra !== undefined) return false
  return RECRUITING_LOCAL.test(local.split('+')[0].replace(/[._-]/g, ''))
}
