// Plain-language copy for the scheduler freshness codes a tenant can see (#698). No imports: the client panel uses it.
const REASON: Record<string, string> = {
  scheduler_stale: 'The scheduler has not completed a run recently.',
  scheduler_crashed: 'The last scheduler run stopped without finishing.',
  scheduler_never_ran: 'The scheduler has never run.',
  scheduler_failed: 'The latest scheduler run failed and none has succeeded since.',
  scheduler_lease_lost: 'The latest scheduler run was interrupted and none has succeeded since.',
  reply_sync_failing: 'Reading replies has failed several times in a row.',
  followups_failing: 'Follow-ups have failed several times in a row.',
  sequences_failing: 'Sequence steps have failed several times in a row.',
  first_touch_failing: 'Sending first emails has failed several times in a row.',
  autopilot_failing: 'Autopilot has failed several times in a row.',
  reply_sync_stale: 'Replies have not been read successfully for over two hours.',
  due_work_overdue: 'A due step is more than an hour overdue.',
}
const HOLD: Record<string, string> = { autopilot_off: 'autopilot is off or its consent needs renewing', followups_off: 'follow-ups are off', paused: 'sending is paused', daily_cap: 'today\'s send cap is reached', changed_since_approval: 'a step changed after approval', reply_sync_partial: 'older sent threads are still being read for the first time',
  off: 'it is turned off', consent_required: 'its consent needs renewing', warmup: 'your mailbox is still warming up', connection_replaced: 'Gmail was reconnected, so it needs turning on again',
  gmail_not_connected: 'Gmail is not connected', gmail_reconnect_needed: 'Gmail needs reconnecting', reading_not_enabled: 'reply reading is not turned on', unknown: 'the reason was not recorded' }
const KIND: Record<string, string> = { reply_sync: 'replies', followups: 'follow-ups', sequences: 'sequence steps', first_touch: 'first emails', autopilot: 'automatic first emails' }
export const reasonCopy = (r: string): string => REASON[r] ?? r
export const holdCopy = (h: string): string => HOLD[h] ?? h
export const kindCopy = (k: string): string => KIND[k] ?? k
