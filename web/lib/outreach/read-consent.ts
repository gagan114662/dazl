// Browser-safe single source for the actual consent shown before Gmail read acquisition.
// This version requires fresh acceptance; old narrower grants never authorize daemon-notice searching.
export const READ_CONSENT_VERSION = '2026-11-01-delivery-notices'
export const READ_CONSENT_TEXT = [
  'dazl reads replies in email threads it started for you. It also searches mailer-daemon and postmaster delivery-failure notices in a bounded time window, then reads candidate notices to check whether they match its recorded sends.',
  'Only notices matching a recorded send are kept for that outreach. For unmatched notices, dazl keeps only the message identifier, time and unmatched status to avoid repeat processing, not the sender, recipient or message content.',
  'It uses replies and matched notices to hold unsafe follow-ups and honor opt-outs. A possible delivery failure without verified provenance is for your review, not automatic suppression.',
  'dazl keeps reply senders, times, short excerpts and results, not full reply bodies. You can turn reading off any time; this stops reading and follow-ups.',
]
