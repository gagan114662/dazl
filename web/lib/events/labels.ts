// Pure (no db import) so the client Leads page can use it too.
// User-facing name of a stored event type. Stored type names stay as they are (no migration).
// The only producer of hiring_surge is a one-time job-board snapshot of how many roles are
// open, with no earlier snapshot to compare, so it is shown as what it observed.
export function eventTypeLabel(t: string): string {
  return t === 'hiring_surge' ? 'open roles (board snapshot, growth not measured)' : t.replace(/_/g, ' ')
}
