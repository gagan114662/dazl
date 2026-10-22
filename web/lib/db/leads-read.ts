// Async read interface for the GET /api/leads slice (architecture slice W1).
// Route code depends on this interface only, so the same contract can later be
// implemented over Postgres without touching the route. The SQLite adapter
// delegates to the existing store modules - a strangler step that measures the
// port pattern, NOT a claim that the remaining ~49 modules port the same way.
import type Database from 'better-sqlite3'
import { countHiddenLeads, getJob, listLeads } from '../scan/store.ts'
import { sequenceStatusByLead } from '../outreach/sequences.ts'
import { enrichmentsForLeads } from '../connectors/store.ts'
import { eventsForLeads } from '../events/store.ts'
import { leadPriorities } from '../events/prioritize.ts'
import { lookalikeSignals } from '../scan/lookalike.ts'

type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never

export interface LeadsReadDb {
  getJob(...args: Tail<Parameters<typeof getJob>>): Promise<ReturnType<typeof getJob>>
  listLeads(...args: Tail<Parameters<typeof listLeads>>): Promise<ReturnType<typeof listLeads>>
  countHiddenLeads(...args: Tail<Parameters<typeof countHiddenLeads>>): Promise<ReturnType<typeof countHiddenLeads>>
  sequenceStatusByLead(...args: Tail<Parameters<typeof sequenceStatusByLead>>): Promise<ReturnType<typeof sequenceStatusByLead>>
  enrichmentsForLeads(...args: Tail<Parameters<typeof enrichmentsForLeads>>): Promise<ReturnType<typeof enrichmentsForLeads>>
  eventsForLeads(...args: Tail<Parameters<typeof eventsForLeads>>): Promise<ReturnType<typeof eventsForLeads>>
  leadPriorities(...args: Tail<Parameters<typeof leadPriorities>>): Promise<ReturnType<typeof leadPriorities>>
  lookalikeSignals(...args: Tail<Parameters<typeof lookalikeSignals>>): Promise<ReturnType<typeof lookalikeSignals>>
}

export function sqliteLeadsRead(db: Database.Database): LeadsReadDb {
  return {
    getJob: (userId, id) => Promise.resolve(getJob(db, userId, id)),
    listLeads: (userId, jobId, limit, includeHidden) => Promise.resolve(listLeads(db, userId, jobId, limit, includeHidden)),
    countHiddenLeads: (userId, jobId) => Promise.resolve(countHiddenLeads(db, userId, jobId)),
    sequenceStatusByLead: (tenantId, deps) => Promise.resolve(sequenceStatusByLead(db, tenantId, deps)),
    enrichmentsForLeads: (tenantId, leadIds) => Promise.resolve(enrichmentsForLeads(db, tenantId, leadIds)),
    eventsForLeads: (tenantId, leads, opts) => Promise.resolve(eventsForLeads(db, tenantId, leads, opts)),
    leadPriorities: (tenantId, leads, opts) => Promise.resolve(leadPriorities(db, tenantId, leads, opts)),
    lookalikeSignals: (tenantId, leads) => Promise.resolve(lookalikeSignals(db, tenantId, leads)),
  }
}
