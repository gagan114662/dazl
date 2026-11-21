// #533: a hiring signal is a timing signal, never proof the company will buy. Shown wherever a lead's hiring signal is shown.
// Pure and browser-safe (the Leads view imports it).
const HIRING = /\b(?:hir(?:e|es|ed|ing)|recruit\w*|vacanc(?:y|ies)|job\s+(?:posting|opening|ad|listing)s?)\b|\bpost(?:ed|s|ing)?\b[^.;]{0,80}\b(?:job|role|position|opening|vacancy)\b/i
export const HIRING_NOT_BUYING = 'Hiring is a timing signal, not proof they will buy.'
export const isHiringSignal = (signal: string | null | undefined): boolean => HIRING.test(signal ?? '')
export const hiringTimingLine = (signal: string | null | undefined): string | null => isHiringSignal(signal) ? HIRING_NOT_BUYING : null
