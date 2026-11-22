import type { OutreachProvenance } from './provenance.ts'
import { eventDateCopy } from '../scan/date-copy.ts'

// The event-date line the outreach provenance screen shows (app/app/outreach/provenance.tsx). A pure module, so the client
// screen does not import the database-side reader (#1176): the record already carries the card's own verdicts (day_verified,
// timing, window_missed from messageProvenance), so the line reads exactly as the lead card does.
export const provenanceDateLine = (p: OutreachProvenance): string => eventDateCopy(p.event_date, p.date_status, p.timing, { dayVerified: p.day_verified, windowMissed: p.window_missed })
