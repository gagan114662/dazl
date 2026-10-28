-- Onboarding saves the reviewed buyer profile (normalized Icp as JSON) per user. Nullable; no backfill.
ALTER TABLE users ADD COLUMN buyer_profile TEXT;
