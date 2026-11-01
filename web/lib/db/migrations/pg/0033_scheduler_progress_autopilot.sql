-- #448: the tick's autopilot first-touch pass (lib/outreach/autopilot.ts, #411) records its outcome per tenant in
-- scheduler_progress like reply sync, follow-ups and sequences do, so a failing or held pass is visible to tenant
-- freshness and scheduler health. The kind check gains 'autopilot'. 'first_touch' (0026) stays: live stores carry
-- those rows and the legacy on-row hold drain still reports under it.
ALTER TABLE scheduler_progress DROP CONSTRAINT scheduler_progress_kind_check;
ALTER TABLE scheduler_progress ADD CONSTRAINT scheduler_progress_kind_check CHECK (kind IN ('reply_sync','followups','sequences','first_touch','autopilot'));
