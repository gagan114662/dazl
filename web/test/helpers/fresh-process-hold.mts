// Runs in a FRESH process against a database file: confirms the lead, confirms the domain, then tries to draft. Prints the outcome as JSON. No network.
import Database from 'better-sqlite3'
import { sqliteDb } from '../../lib/db/client.ts'
import { confirmLeadReview } from '../../lib/scan/review-confirm.ts'
import { setDomainReview } from '../../lib/scan/domain-review-action.ts'
import { createDraft } from '../../lib/outreach/service.ts'
import { requiredGateHeld } from '../../lib/scan/held-state.ts'

const [file, leadId] = process.argv.slice(2)
const db = new Database(file)
const out: Record<string, unknown> = { heldBefore: requiredGateHeld(db, 'A', leadId) }
out.confirmed = await confirmLeadReview(sqliteDb(db), 'A', leadId)
try { setDomainReview(db, 'A', leadId, 'confirm'); out.domain = 'confirmed' } catch (e) { out.domain = `refused: ${(e as Error).message}` }
try { out.draft = createDraft(db, 'A', leadId, 'Acme') } catch (e) { out.draftError = (e as Error).message }
out.heldAfter = requiredGateHeld(db, 'A', leadId)
console.log(`RESULT ${JSON.stringify(out)}`)
