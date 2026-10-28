-- Lease fencing token (lib/shared/lease.ts): a per-name generation that every takeover increments; writes made under a
-- lease check it in their own transaction, so a holder that lost the lease can no longer write.
ALTER TABLE app_leases ADD COLUMN generation BIGINT NOT NULL DEFAULT 0;
