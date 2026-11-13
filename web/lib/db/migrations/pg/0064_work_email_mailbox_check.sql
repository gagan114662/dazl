-- #1036 (stacked on #899): the free-tier mailbox check of an address a provider found but did not verify (lib/people/work-email.ts
-- checkMailbox). The lookup's status stays what the provider said; these record whether the mailbox was then checked, by whom, when.
-- Numbered 0064 after #899's 0063 (main's highest is 0062): renumber at merge if another migration lands first. SQLite twin: migrateWorkEmail.
ALTER TABLE work_email_lookups ADD COLUMN mailbox_check TEXT CHECK (mailbox_check IS NULL OR mailbox_check IN ('pending','valid','catch_all','undeliverable','uncertain','refused'));

ALTER TABLE work_email_lookups ADD COLUMN mailbox_verifier TEXT CHECK (mailbox_verifier IS NULL OR char_length(mailbox_verifier) <= 40);

ALTER TABLE work_email_lookups ADD COLUMN mailbox_checked_at BIGINT;

CREATE INDEX IF NOT EXISTS work_email_lookups_mailbox_checked ON work_email_lookups (tenant_id, mailbox_checked_at);
