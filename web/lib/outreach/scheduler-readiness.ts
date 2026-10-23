import type Database from 'better-sqlite3'
import { getState } from './autopilot.ts'
import { hasReadConsent } from './replies.ts'
import { gmailStatus } from '../gmail/oauth.ts'
import { getSettings } from './service.ts'
import { anyUncertainSend } from './send-budget.ts'

// Configuration facts only. This is not a heartbeat and says nothing about one sequence.
export type SchedulerFlag = 'kill_switch' | 'operator_off' | 'paused' | 'configured_on'
export interface Gate { id: 'gmail' | 'read_consent' | 'sender_identity' | 'uncertain_send'; ok: boolean; scope: 'account'|'system' }
export function schedulerReadiness(db: Database.Database, tenantId: string, env: Record<string, string | undefined> = process.env): { scheduler: SchedulerFlag; gates: Gate[] } {
  const scheduler: SchedulerFlag = env.AUTOPILOT_KILL === '1' ? 'kill_switch' : env.SEQUENCES_ENABLED !== '1' ? 'operator_off' : getState(db, tenantId).paused ? 'paused' : 'configured_on'
  const g = gmailStatus(db, tenantId)
  return { scheduler, gates: [
    { id: 'gmail', ok: g?.status === 'active', scope: 'account' },
    { id: 'read_consent', ok: hasReadConsent(db, tenantId) && g?.read_granted === true, scope: 'account' },
    { id: 'sender_identity', ok: !!getSettings(db, tenantId), scope: 'account' },
    { id: 'uncertain_send', ok: !anyUncertainSend(db, tenantId), scope: 'system' },
  ] }
}
