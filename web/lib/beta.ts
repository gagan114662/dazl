// The beta rules the owner fixed on 2026-11-23, as two operator switches and the sentences the app shows while they are off.
// Both switches are OFF unless set to exactly '1'. Pure and dependency-free, so pages, routes and the scheduler read one rule.
//
//   AUTOPILOT_AVAILABLE=1  autopilot may be offered and may run (it still needs AUTOPILOT_ENABLED=1 and no AUTOPILOT_KILL;
//                          lib/outreach/autopilot.ts autopilotAvailable is the one place that reads all three).
//   BILLING_AVAILABLE=1    the paid upgrade may be offered and a checkout may be started.
type Env = Record<string, string | undefined>
export const autopilotInBeta = (env: Env = process.env): boolean => env.AUTOPILOT_AVAILABLE === '1'
export const billingAvailable = (env: Env = process.env): boolean => env.BILLING_AVAILABLE === '1'

export const AUTOPILOT_BETA_TEXT = 'Autopilot is not available during the beta. Every message is reviewed and sent by you.'
export const BILLING_BETA_TEXT = 'dazl is free during the beta. We don\'t charge you anything.'
