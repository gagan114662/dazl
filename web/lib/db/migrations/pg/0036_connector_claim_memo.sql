-- Recovery follow-up to 0035 (#382, lib/connectors/store.ts + lib/enrich/index.ts): a terminal organization
-- lookup settles with a durable memo of the org result the people step needs, so a pass that crashed AFTER the
-- paid organization lookup but BEFORE the people search resumes the people step without paying for the
-- organization again. The memo is written in the same transaction as the claim's terminal settle, is immutable
-- once set (the settle guards on status='reserved' AND memo IS NULL), and its presence is authoritative:
-- memo == "the agreement check passed; the people step may resume". No claim or audit row is ever rewritten or
-- deleted by any automatic path; a HELD claim's only release is an owner-explicit, audit-rowed action.
ALTER TABLE connector_claims ADD COLUMN memo TEXT;
