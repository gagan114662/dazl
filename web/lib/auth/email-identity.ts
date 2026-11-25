// One free trial per PERSON, not per spelling (#1801, #1604 E2). The trial grant compares mailboxes, and a
// mailbox has many spellings: gagan+2@gmail.com and g.agan@gmail.com deliver to the same inbox as
// gagan@gmail.com. trialIdentity is the canonical key for that comparison — a pure function with no I/O,
// so the grant check (lib/billing/trial-budget.ts, via the hunk proposed on #1801) and any future caller
// share exactly one definition.
//
// The rules, deliberately the same ones canonicalMailbox has always applied in the trial grant:
//   - trim and lowercase everything;
//   - strip the +tag from the local part for EVERY domain (plus addressing is a mailbox feature, and a
//     tag never makes a second person);
//   - on Gmail only (gmail.com and googlemail.com), remove the dots from the local part — Gmail ignores
//     them; every other provider treats a.b and ab as different mailboxes, so their dots stay;
//   - googlemail.com is Gmail: the domain maps to gmail.com.
const GMAIL = ['gmail.com', 'googlemail.com']

export function trialIdentity(email: string): string {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@')
  const base = local.split('+')[0]
  return GMAIL.includes(domain) ? `${base.replaceAll('.', '')}@gmail.com` : `${base}@${domain}`
}
