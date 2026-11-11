// The "scans used this month" line on Settings > Plan. The count is the plan's own quota (lib/plans.ts SCANS_THIS_MONTH_SQL): it
// deliberately leaves out scans paid by the shared free trial (funded_by = 'trial'), which never spend the plan. On an account that is
// on the trial the line says so, so "0 of 50 used" next to three used free scans is not read as a miscount.
export function usageLine(u: { scans_used: number; scan_limit: number | null; trial: unknown }): string {
  const base = u.scan_limit === null ? `${u.scans_used} scans this month, unlimited.` : `${u.scans_used} of ${u.scan_limit} scans used this month.`
  return u.trial ? `${base} Free trial scans are counted separately and do not use this.` : base
}
