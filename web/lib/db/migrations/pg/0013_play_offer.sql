-- The offer reviewed for one play (lib/scan/play-offer.ts, #349): what the tenant sells for that play's research and
-- drafting, separate from the business profile. NULL: the play keeps the offer recorded when it was created (seller).
ALTER TABLE scan_jobs ADD COLUMN offer TEXT CHECK (offer IS NULL OR char_length(offer) <= 150);
ALTER TABLE scan_jobs ADD COLUMN offer_set_at BIGINT;
