// The role-mailbox words (info@, sales@, ...) in one PURE module: no Node APIs, so a browser component can use rules built on it
// (lib/enrich/person-name.ts isMailboxShaped, via lib/people/work-email-eligible.ts) without pulling the site crawler into the bundle.
// lib/connectors/sitecrawl.ts re-exports it, so every existing import is unchanged.
export const ROLE = /^(info|hello|hi|contact|contactus|enquiries|enquiry|inquiries|inquiry|sales|business|office|admin|general|mail|team|support|help|press|media|partnerships|partners|bookings|booking|reservations|hola|contacto|kontakt|bonjour|ciao|ola|connect)$/i
