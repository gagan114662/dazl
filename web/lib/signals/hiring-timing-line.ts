// #533: a hiring signal is a timing signal, never proof the company will buy. Shown wherever a lead's hiring signal is shown.
// Pure and browser-safe (the Leads view imports it).
const HIRING = /\b(?:hir(?:e|es|ed|ing)|recruit\w*|vacanc(?:y|ies)|job\s+(?:posting|opening|ad|listing)s?)\b|\bpost(?:ed|s|ing)?\b[^.;]{0,80}\b(?:job|role|position|opening|vacancy)\b/i
export const HIRING_NOT_BUYING = 'Hiring is a timing signal, not proof they will buy.'
// Qodo #1510 M3: the stored kind decides first (a title-only signal such as "Front desk receptionist job" stored as hiring); the text is the fallback.
export const isHiringSignal = (signal: string | null | undefined, kind?: string | null): boolean => kind === 'hiring' || kind === 'hiring_relevant_role' || HIRING.test(signal ?? '') || /\bjob\b\s*$/i.test((signal ?? '').trim())
export const hiringTimingLine = (signal: string | null | undefined, kind?: string | null): string | null => isHiringSignal(signal, kind) ? HIRING_NOT_BUYING : null
