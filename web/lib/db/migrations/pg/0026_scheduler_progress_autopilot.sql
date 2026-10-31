-- #448: the tick's autopilot first-touch drain (lib/outreach/autopilot.ts, #411) records its outcome per tenant in
-- scheduler_progress like reply sync, follow-ups and sequences do, so a failing or held drain is visible to tenant
-- freshness and scheduler health. The kind check gains 'autopilot'.
ALTER TABLE scheduler_progress DROP CONSTRAINT scheduler_progress_kind_check;
ALTER TABLE scheduler_progress ADD CONSTRAINT scheduler_progress_kind_check CHECK (kind IN ('reply_sync','followups','sequences','autopilot'));
