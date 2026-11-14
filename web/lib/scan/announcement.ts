// #878: a lead whose day is a press release's own publication day (lib/scan/structured-date.ts NewsArticle rule) says so wherever its day is worded. The stored proof stays
// 'page_bound' (the existing kinds only); the note that structured-date.ts writes starts with ANNOUNCEMENT_NOTE, and that is how the copy tells an announcement day from a
// day the page states for the event.
export const ANNOUNCEMENT_NOTE = "the announcement's own publication day"
export const isAnnouncementDay = (proofNote: string | null | undefined): boolean => typeof proofNote === 'string' && proofNote.startsWith(ANNOUNCEMENT_NOTE)
