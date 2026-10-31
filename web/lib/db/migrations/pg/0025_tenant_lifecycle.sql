-- Tenant deletion lifecycle (lib/tenant/lifecycle.ts, issue #359): the tombstone of every deleted tenant and the ids of
-- its deleted parent rows, and on every tenant-scoped table (and users, organizations) two guards, BEFORE INSERT and
-- BEFORE UPDATE OF the tenant column or parent key, that refuse a row for a deleted tenant (or under one of its deleted
-- parents) whether it is inserted or moved there, so in-flight work or a late write cannot recreate erased data and no
-- row can change hands into a deleted tenant. Generated from lib/db/tenant-guard.ts through scripts/pg-migrate
-- (translate-schema.ts): 164 guard triggers. Do not edit by hand; regenerate.
CREATE TABLE tenant_tombstone_keys (
      deleted_tenant TEXT NOT NULL,
      tbl            TEXT NOT NULL,
      key            TEXT NOT NULL,
      PRIMARY KEY (tbl, key)
    );

CREATE TABLE tenant_tombstones (
      deleted_tenant TEXT PRIMARY KEY,
      requested_at   BIGINT NOT NULL,
      requested_by   TEXT NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 200),
      state          TEXT NOT NULL CHECK (state IN ('requested','revoked','cancelled','erased','completed')),
      policy         TEXT NOT NULL,
      retained       TEXT,
      completed_at   BIGINT
    );

CREATE OR REPLACE FUNCTION dazl_guard_tomb_advanced_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_advanced_consent ON advanced_consent;
CREATE TRIGGER tomb_advanced_consent BEFORE INSERT ON advanced_consent FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_advanced_consent();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_autopilot_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_autopilot_audit ON autopilot_audit;
CREATE TRIGGER tomb_autopilot_audit BEFORE INSERT ON autopilot_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_autopilot_audit();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_autopilot_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_autopilot_settings ON autopilot_settings;
CREATE TRIGGER tomb_autopilot_settings BEFORE INSERT ON autopilot_settings FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_autopilot_settings();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_calcom_bookings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_calcom_bookings ON calcom_bookings;
CREATE TRIGGER tomb_calcom_bookings BEFORE INSERT ON calcom_bookings FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_calcom_bookings();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_calcom_hooks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_calcom_hooks ON calcom_hooks;
CREATE TRIGGER tomb_calcom_hooks BEFORE INSERT ON calcom_hooks FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_calcom_hooks();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_commenter_batches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_commenter_batches ON commenter_batches;
CREATE TRIGGER tomb_commenter_batches BEFORE INSERT ON commenter_batches FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_commenter_batches();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_commenter_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'commenter_batches' AND key = NEW.batch_id) OR NEW.batch_id IN (SELECT id FROM commenter_batches WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_commenter_rows ON commenter_rows;
CREATE TRIGGER tomb_commenter_rows BEFORE INSERT ON commenter_rows FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_commenter_rows();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_company_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_company_events ON company_events;
CREATE TRIGGER tomb_company_events BEFORE INSERT ON company_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_company_events();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_connector_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_connector_audit ON connector_audit;
CREATE TRIGGER tomb_connector_audit BEFORE INSERT ON connector_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_connector_audit();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_consent_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_consent_ledger ON consent_ledger;
CREATE TRIGGER tomb_consent_ledger BEFORE INSERT ON consent_ledger FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_consent_ledger();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_crm_push_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_crm_push_claims ON crm_push_claims;
CREATE TRIGGER tomb_crm_push_claims BEFORE INSERT ON crm_push_claims FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_crm_push_claims();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_csv_batches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_csv_batches ON csv_batches;
CREATE TRIGGER tomb_csv_batches BEFORE INSERT ON csv_batches FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_csv_batches();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_csv_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'csv_batches' AND key = NEW.batch_id) OR NEW.batch_id IN (SELECT id FROM csv_batches WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_csv_rows ON csv_rows;
CREATE TRIGGER tomb_csv_rows BEFORE INSERT ON csv_rows FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_csv_rows();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_email_candidates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_email_candidates ON email_candidates;
CREATE TRIGGER tomb_email_candidates BEFORE INSERT ON email_candidates FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_email_candidates();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_email_patterns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_email_patterns ON email_patterns;
CREATE TRIGGER tomb_email_patterns BEFORE INSERT ON email_patterns FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_email_patterns();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_email_tokens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_email_tokens ON email_tokens;
CREATE TRIGGER tomb_email_tokens BEFORE INSERT ON email_tokens FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_email_tokens();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_evidence_purge_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_evidence_purge_audit ON evidence_purge_audit;
CREATE TRIGGER tomb_evidence_purge_audit BEFORE INSERT ON evidence_purge_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_evidence_purge_audit();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_followup_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_followup_messages ON followup_messages;
CREATE TRIGGER tomb_followup_messages BEFORE INSERT ON followup_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_followup_messages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_followup_threads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_followup_threads ON followup_threads;
CREATE TRIGGER tomb_followup_threads BEFORE INSERT ON followup_threads FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_followup_threads();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_gmail_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_gmail_accounts ON gmail_accounts;
CREATE TRIGGER tomb_gmail_accounts BEFORE INSERT ON gmail_accounts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_gmail_accounts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_hiring_feed_crawl() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_hiring_feed_crawl ON hiring_feed_crawl;
CREATE TRIGGER tomb_hiring_feed_crawl BEFORE INSERT ON hiring_feed_crawl FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_hiring_feed_crawl();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_inbound_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_inbound_messages ON inbound_messages;
CREATE TRIGGER tomb_inbound_messages BEFORE INSERT ON inbound_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_inbound_messages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_inbox_thread_reads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_inbox_thread_reads ON inbox_thread_reads;
CREATE TRIGGER tomb_inbox_thread_reads BEFORE INSERT ON inbox_thread_reads FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_inbox_thread_reads();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_invitations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_invitations ON invitations;
CREATE TRIGGER tomb_invitations BEFORE INSERT ON invitations FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_invitations();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_lead_enrichments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_lead_enrichments ON lead_enrichments;
CREATE TRIGGER tomb_lead_enrichments BEFORE INSERT ON lead_enrichments FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_lead_enrichments();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_lead_evidence_copies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_lead_evidence_copies ON lead_evidence_copies;
CREATE TRIGGER tomb_lead_evidence_copies BEFORE INSERT ON lead_evidence_copies FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_lead_evidence_copies();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_lead_qualifications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_lead_qualifications ON lead_qualifications;
CREATE TRIGGER tomb_lead_qualifications BEFORE INSERT ON lead_qualifications FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_lead_qualifications();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_lead_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'leads' AND key = NEW.lead_id) OR NEW.lead_id IN (SELECT id FROM leads WHERE scan_job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_lead_sources ON lead_sources;
CREATE TRIGGER tomb_lead_sources BEFORE INSERT ON lead_sources FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_lead_sources();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_leads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND key = NEW.scan_job_id) OR NEW.scan_job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_leads ON leads;
CREATE TRIGGER tomb_leads BEFORE INSERT ON leads FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_leads();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_mail_read_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_mail_read_consent ON mail_read_consent;
CREATE TRIGGER tomb_mail_read_consent BEFORE INSERT ON mail_read_consent FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_mail_read_consent();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_memberships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_memberships ON memberships;
CREATE TRIGGER tomb_memberships BEFORE INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_memberships();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_monitor_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'monitors' AND key = NEW.monitor_id) OR NEW.monitor_id IN (SELECT id FROM monitors WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_monitor_runs ON monitor_runs;
CREATE TRIGGER tomb_monitor_runs BEFORE INSERT ON monitor_runs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_monitor_runs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_monitor_seen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'monitors' AND key = NEW.monitor_id) OR NEW.monitor_id IN (SELECT id FROM monitors WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_monitor_seen ON monitor_seen;
CREATE TRIGGER tomb_monitor_seen BEFORE INSERT ON monitor_seen FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_monitor_seen();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_monitors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_monitors ON monitors;
CREATE TRIGGER tomb_monitors BEFORE INSERT ON monitors FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_monitors();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_newsjacks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_newsjacks ON newsjacks;
CREATE TRIGGER tomb_newsjacks BEFORE INSERT ON newsjacks FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_newsjacks();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_oauth_identities() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_oauth_identities ON oauth_identities;
CREATE TRIGGER tomb_oauth_identities BEFORE INSERT ON oauth_identities FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_oauth_identities();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_oauth_states() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_oauth_states ON oauth_states;
CREATE TRIGGER tomb_oauth_states BEFORE INSERT ON oauth_states FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_oauth_states();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_organizations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_organizations ON organizations;
CREATE TRIGGER tomb_organizations BEFORE INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_organizations();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_outreach_llm_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_outreach_llm_usage ON outreach_llm_usage;
CREATE TRIGGER tomb_outreach_llm_usage BEFORE INSERT ON outreach_llm_usage FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_outreach_llm_usage();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_outreach_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_outreach_messages ON outreach_messages;
CREATE TRIGGER tomb_outreach_messages BEFORE INSERT ON outreach_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_outreach_messages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_outreach_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_outreach_settings ON outreach_settings;
CREATE TRIGGER tomb_outreach_settings BEFORE INSERT ON outreach_settings FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_outreach_settings();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_outreach_signal_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_outreach_signal_context ON outreach_signal_context;
CREATE TRIGGER tomb_outreach_signal_context BEFORE INSERT ON outreach_signal_context FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_outreach_signal_context();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_play_research_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_play_research_sources ON play_research_sources;
CREATE TRIGGER tomb_play_research_sources BEFORE INSERT ON play_research_sources FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_play_research_sources();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_reopen_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_reopen_messages ON reopen_messages;
CREATE TRIGGER tomb_reopen_messages BEFORE INSERT ON reopen_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_reopen_messages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_reply_drafts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_reply_drafts ON reply_drafts;
CREATE TRIGGER tomb_reply_drafts BEFORE INSERT ON reply_drafts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_reply_drafts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_reply_queries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_reply_queries ON reply_queries;
CREATE TRIGGER tomb_reply_queries BEFORE INSERT ON reply_queries FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_reply_queries();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_reply_threads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_reply_threads ON reply_threads;
CREATE TRIGGER tomb_reply_threads BEFORE INSERT ON reply_threads FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_reply_threads();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_scan_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_scan_jobs ON scan_jobs;
CREATE TRIGGER tomb_scan_jobs BEFORE INSERT ON scan_jobs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_scan_jobs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_scan_model_calls() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_scan_model_calls ON scan_model_calls;
CREATE TRIGGER tomb_scan_model_calls BEFORE INSERT ON scan_model_calls FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_scan_model_calls();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_scan_run_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND key = NEW.job_id) OR NEW.job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_scan_run_report ON scan_run_report;
CREATE TRIGGER tomb_scan_run_report BEFORE INSERT ON scan_run_report FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_scan_run_report();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_scan_source_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND key = NEW.job_id) OR NEW.job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_scan_source_runs ON scan_source_runs;
CREATE TRIGGER tomb_scan_source_runs BEFORE INSERT ON scan_source_runs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_scan_source_runs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_scan_source_stats() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND key = NEW.job_id) OR NEW.job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_scan_source_stats ON scan_source_stats;
CREATE TRIGGER tomb_scan_source_stats BEFORE INSERT ON scan_source_stats FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_scan_source_stats();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_scheduler_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_scheduler_progress ON scheduler_progress;
CREATE TRIGGER tomb_scheduler_progress BEFORE INSERT ON scheduler_progress FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_scheduler_progress();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_seo_audits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_seo_audits ON seo_audits;
CREATE TRIGGER tomb_seo_audits BEFORE INSERT ON seo_audits FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_seo_audits();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_seo_briefs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_seo_briefs ON seo_briefs;
CREATE TRIGGER tomb_seo_briefs BEFORE INSERT ON seo_briefs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_seo_briefs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_seo_index_configs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_seo_index_configs ON seo_index_configs;
CREATE TRIGGER tomb_seo_index_configs BEFORE INSERT ON seo_index_configs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_seo_index_configs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_seo_index_keywords() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_seo_index_keywords ON seo_index_keywords;
CREATE TRIGGER tomb_seo_index_keywords BEFORE INSERT ON seo_index_keywords FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_seo_index_keywords();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_seo_index_results() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_seo_index_results ON seo_index_results;
CREATE TRIGGER tomb_seo_index_results BEFORE INSERT ON seo_index_results FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_seo_index_results();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_seo_index_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_seo_index_runs ON seo_index_runs;
CREATE TRIGGER tomb_seo_index_runs BEFORE INSERT ON seo_index_runs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_seo_index_runs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_sequence_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_sequence_settings ON sequence_settings;
CREATE TRIGGER tomb_sequence_settings BEFORE INSERT ON sequence_settings FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_sequence_settings();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_sequence_steps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_sequence_steps ON sequence_steps;
CREATE TRIGGER tomb_sequence_steps BEFORE INSERT ON sequence_steps FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_sequence_steps();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_sequences() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_sequences ON sequences;
CREATE TRIGGER tomb_sequences BEFORE INSERT ON sequences FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_sequences();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_sessions ON sessions;
CREATE TRIGGER tomb_sessions BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_sessions();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_source_reviews() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_source_reviews ON source_reviews;
CREATE TRIGGER tomb_source_reviews BEFORE INSERT ON source_reviews FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_source_reviews();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_stripe_ended_subscriptions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_stripe_ended_subscriptions ON stripe_ended_subscriptions;
CREATE TRIGGER tomb_stripe_ended_subscriptions BEFORE INSERT ON stripe_ended_subscriptions FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_stripe_ended_subscriptions();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_suppressions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_suppressions ON suppressions;
CREATE TRIGGER tomb_suppressions BEFORE INSERT ON suppressions FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_suppressions();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_system_mail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_system_mail_outbox ON system_mail_outbox;
CREATE TRIGGER tomb_system_mail_outbox BEFORE INSERT ON system_mail_outbox FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_system_mail_outbox();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tenant_competitors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tenant_competitors ON tenant_competitors;
CREATE TRIGGER tomb_tenant_competitors BEFORE INSERT ON tenant_competitors FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tenant_competitors();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tenant_connections() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tenant_connections ON tenant_connections;
CREATE TRIGGER tomb_tenant_connections BEFORE INSERT ON tenant_connections FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tenant_connections();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tenant_connectors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tenant_connectors ON tenant_connectors;
CREATE TRIGGER tomb_tenant_connectors BEFORE INSERT ON tenant_connectors FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tenant_connectors();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tenant_llm_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tenant_llm_keys ON tenant_llm_keys;
CREATE TRIGGER tomb_tenant_llm_keys BEFORE INSERT ON tenant_llm_keys FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tenant_llm_keys();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tenant_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tenant_memory ON tenant_memory;
CREATE TRIGGER tomb_tenant_memory BEFORE INSERT ON tenant_memory FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tenant_memory();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tenant_plans() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tenant_plans ON tenant_plans;
CREATE TRIGGER tomb_tenant_plans BEFORE INSERT ON tenant_plans FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tenant_plans();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tenant_spend_pools() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tenant_spend_pools ON tenant_spend_pools;
CREATE TRIGGER tomb_tenant_spend_pools BEFORE INSERT ON tenant_spend_pools FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tenant_spend_pools();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_tinyfish_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_tinyfish_usage ON tinyfish_usage;
CREATE TRIGGER tomb_tinyfish_usage BEFORE INSERT ON tinyfish_usage FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_tinyfish_usage();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_trial_reservations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_trial_reservations ON trial_reservations;
CREATE TRIGGER tomb_trial_reservations BEFORE INSERT ON trial_reservations FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_trial_reservations();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_trial_scans() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_trial_scans ON trial_scans;
CREATE TRIGGER tomb_trial_scans BEFORE INSERT ON trial_scans FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_trial_scans();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_advanced_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_advanced_consent ON advanced_consent;
CREATE TRIGGER tomb_upd_advanced_consent BEFORE UPDATE OF tenant_id ON advanced_consent FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_advanced_consent();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_autopilot_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_autopilot_audit ON autopilot_audit;
CREATE TRIGGER tomb_upd_autopilot_audit BEFORE UPDATE OF tenant_id ON autopilot_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_autopilot_audit();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_autopilot_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_autopilot_settings ON autopilot_settings;
CREATE TRIGGER tomb_upd_autopilot_settings BEFORE UPDATE OF tenant_id ON autopilot_settings FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_autopilot_settings();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_calcom_bookings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_calcom_bookings ON calcom_bookings;
CREATE TRIGGER tomb_upd_calcom_bookings BEFORE UPDATE OF tenant_id ON calcom_bookings FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_calcom_bookings();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_calcom_hooks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_calcom_hooks ON calcom_hooks;
CREATE TRIGGER tomb_upd_calcom_hooks BEFORE UPDATE OF tenant_id ON calcom_hooks FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_calcom_hooks();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_commenter_batches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_commenter_batches ON commenter_batches;
CREATE TRIGGER tomb_upd_commenter_batches BEFORE UPDATE OF user_id ON commenter_batches FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_commenter_batches();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_commenter_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'commenter_batches' AND key = NEW.batch_id) OR NEW.batch_id IN (SELECT id FROM commenter_batches WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_commenter_rows ON commenter_rows;
CREATE TRIGGER tomb_upd_commenter_rows BEFORE UPDATE OF batch_id ON commenter_rows FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_commenter_rows();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_company_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_company_events ON company_events;
CREATE TRIGGER tomb_upd_company_events BEFORE UPDATE OF tenant_id ON company_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_company_events();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_connector_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_connector_audit ON connector_audit;
CREATE TRIGGER tomb_upd_connector_audit BEFORE UPDATE OF tenant_id ON connector_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_connector_audit();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_consent_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_consent_ledger ON consent_ledger;
CREATE TRIGGER tomb_upd_consent_ledger BEFORE UPDATE OF tenant_id ON consent_ledger FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_consent_ledger();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_crm_push_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_crm_push_claims ON crm_push_claims;
CREATE TRIGGER tomb_upd_crm_push_claims BEFORE UPDATE OF tenant_id ON crm_push_claims FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_crm_push_claims();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_csv_batches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_csv_batches ON csv_batches;
CREATE TRIGGER tomb_upd_csv_batches BEFORE UPDATE OF user_id ON csv_batches FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_csv_batches();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_csv_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'csv_batches' AND key = NEW.batch_id) OR NEW.batch_id IN (SELECT id FROM csv_batches WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_csv_rows ON csv_rows;
CREATE TRIGGER tomb_upd_csv_rows BEFORE UPDATE OF batch_id ON csv_rows FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_csv_rows();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_email_candidates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_email_candidates ON email_candidates;
CREATE TRIGGER tomb_upd_email_candidates BEFORE UPDATE OF tenant_id ON email_candidates FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_email_candidates();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_email_patterns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_email_patterns ON email_patterns;
CREATE TRIGGER tomb_upd_email_patterns BEFORE UPDATE OF tenant_id ON email_patterns FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_email_patterns();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_email_tokens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_email_tokens ON email_tokens;
CREATE TRIGGER tomb_upd_email_tokens BEFORE UPDATE OF user_id ON email_tokens FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_email_tokens();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_evidence_purge_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_evidence_purge_audit ON evidence_purge_audit;
CREATE TRIGGER tomb_upd_evidence_purge_audit BEFORE UPDATE OF tenant_id ON evidence_purge_audit FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_evidence_purge_audit();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_followup_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_followup_messages ON followup_messages;
CREATE TRIGGER tomb_upd_followup_messages BEFORE UPDATE OF tenant_id ON followup_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_followup_messages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_followup_threads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_followup_threads ON followup_threads;
CREATE TRIGGER tomb_upd_followup_threads BEFORE UPDATE OF tenant_id ON followup_threads FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_followup_threads();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_gmail_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_gmail_accounts ON gmail_accounts;
CREATE TRIGGER tomb_upd_gmail_accounts BEFORE UPDATE OF tenant_id ON gmail_accounts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_gmail_accounts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_hiring_feed_crawl() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_hiring_feed_crawl ON hiring_feed_crawl;
CREATE TRIGGER tomb_upd_hiring_feed_crawl BEFORE UPDATE OF tenant_id ON hiring_feed_crawl FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_hiring_feed_crawl();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_inbound_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_inbound_messages ON inbound_messages;
CREATE TRIGGER tomb_upd_inbound_messages BEFORE UPDATE OF tenant_id ON inbound_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_inbound_messages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_inbox_thread_reads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_inbox_thread_reads ON inbox_thread_reads;
CREATE TRIGGER tomb_upd_inbox_thread_reads BEFORE UPDATE OF tenant_id ON inbox_thread_reads FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_inbox_thread_reads();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_invitations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_invitations ON invitations;
CREATE TRIGGER tomb_upd_invitations BEFORE UPDATE OF tenant_id ON invitations FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_invitations();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_lead_enrichments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_lead_enrichments ON lead_enrichments;
CREATE TRIGGER tomb_upd_lead_enrichments BEFORE UPDATE OF tenant_id ON lead_enrichments FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_lead_enrichments();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_lead_evidence_copies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_lead_evidence_copies ON lead_evidence_copies;
CREATE TRIGGER tomb_upd_lead_evidence_copies BEFORE UPDATE OF tenant_id ON lead_evidence_copies FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_lead_evidence_copies();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_lead_qualifications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_lead_qualifications ON lead_qualifications;
CREATE TRIGGER tomb_upd_lead_qualifications BEFORE UPDATE OF tenant_id ON lead_qualifications FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_lead_qualifications();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_lead_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'leads' AND key = NEW.lead_id) OR NEW.lead_id IN (SELECT id FROM leads WHERE scan_job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_lead_sources ON lead_sources;
CREATE TRIGGER tomb_upd_lead_sources BEFORE UPDATE OF lead_id ON lead_sources FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_lead_sources();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_leads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND key = NEW.scan_job_id) OR NEW.scan_job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_leads ON leads;
CREATE TRIGGER tomb_upd_leads BEFORE UPDATE OF scan_job_id ON leads FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_leads();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_mail_read_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_mail_read_consent ON mail_read_consent;
CREATE TRIGGER tomb_upd_mail_read_consent BEFORE UPDATE OF tenant_id ON mail_read_consent FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_mail_read_consent();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_memberships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_memberships ON memberships;
CREATE TRIGGER tomb_upd_memberships BEFORE UPDATE OF tenant_id ON memberships FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_memberships();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_monitor_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'monitors' AND key = NEW.monitor_id) OR NEW.monitor_id IN (SELECT id FROM monitors WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_monitor_runs ON monitor_runs;
CREATE TRIGGER tomb_upd_monitor_runs BEFORE UPDATE OF monitor_id ON monitor_runs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_monitor_runs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_monitor_seen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'monitors' AND key = NEW.monitor_id) OR NEW.monitor_id IN (SELECT id FROM monitors WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_monitor_seen ON monitor_seen;
CREATE TRIGGER tomb_upd_monitor_seen BEFORE UPDATE OF monitor_id ON monitor_seen FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_monitor_seen();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_monitors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_monitors ON monitors;
CREATE TRIGGER tomb_upd_monitors BEFORE UPDATE OF user_id ON monitors FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_monitors();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_newsjacks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_newsjacks ON newsjacks;
CREATE TRIGGER tomb_upd_newsjacks BEFORE UPDATE OF tenant_id ON newsjacks FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_newsjacks();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_oauth_identities() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_oauth_identities ON oauth_identities;
CREATE TRIGGER tomb_upd_oauth_identities BEFORE UPDATE OF user_id ON oauth_identities FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_oauth_identities();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_oauth_states() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_oauth_states ON oauth_states;
CREATE TRIGGER tomb_upd_oauth_states BEFORE UPDATE OF tenant_id ON oauth_states FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_oauth_states();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_organizations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_organizations ON organizations;
CREATE TRIGGER tomb_upd_organizations BEFORE UPDATE OF id ON organizations FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_organizations();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_outreach_llm_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_outreach_llm_usage ON outreach_llm_usage;
CREATE TRIGGER tomb_upd_outreach_llm_usage BEFORE UPDATE OF tenant_id ON outreach_llm_usage FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_outreach_llm_usage();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_outreach_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_outreach_messages ON outreach_messages;
CREATE TRIGGER tomb_upd_outreach_messages BEFORE UPDATE OF tenant_id ON outreach_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_outreach_messages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_outreach_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_outreach_settings ON outreach_settings;
CREATE TRIGGER tomb_upd_outreach_settings BEFORE UPDATE OF tenant_id ON outreach_settings FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_outreach_settings();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_outreach_signal_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_outreach_signal_context ON outreach_signal_context;
CREATE TRIGGER tomb_upd_outreach_signal_context BEFORE UPDATE OF tenant_id ON outreach_signal_context FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_outreach_signal_context();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_play_research_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_play_research_sources ON play_research_sources;
CREATE TRIGGER tomb_upd_play_research_sources BEFORE UPDATE OF tenant_id ON play_research_sources FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_play_research_sources();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_reopen_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_reopen_messages ON reopen_messages;
CREATE TRIGGER tomb_upd_reopen_messages BEFORE UPDATE OF tenant_id ON reopen_messages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_reopen_messages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_reply_drafts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_reply_drafts ON reply_drafts;
CREATE TRIGGER tomb_upd_reply_drafts BEFORE UPDATE OF tenant_id ON reply_drafts FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_reply_drafts();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_reply_queries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_reply_queries ON reply_queries;
CREATE TRIGGER tomb_upd_reply_queries BEFORE UPDATE OF tenant_id ON reply_queries FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_reply_queries();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_reply_threads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_reply_threads ON reply_threads;
CREATE TRIGGER tomb_upd_reply_threads BEFORE UPDATE OF tenant_id ON reply_threads FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_reply_threads();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_scan_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_scan_jobs ON scan_jobs;
CREATE TRIGGER tomb_upd_scan_jobs BEFORE UPDATE OF user_id ON scan_jobs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_scan_jobs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_scan_model_calls() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_scan_model_calls ON scan_model_calls;
CREATE TRIGGER tomb_upd_scan_model_calls BEFORE UPDATE OF tenant_id ON scan_model_calls FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_scan_model_calls();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_scan_run_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND key = NEW.job_id) OR NEW.job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_scan_run_report ON scan_run_report;
CREATE TRIGGER tomb_upd_scan_run_report BEFORE UPDATE OF job_id ON scan_run_report FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_scan_run_report();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_scan_source_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND key = NEW.job_id) OR NEW.job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_scan_source_runs ON scan_source_runs;
CREATE TRIGGER tomb_upd_scan_source_runs BEFORE UPDATE OF job_id ON scan_source_runs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_scan_source_runs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_scan_source_stats() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'scan_jobs' AND key = NEW.job_id) OR NEW.job_id IN (SELECT id FROM scan_jobs WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_scan_source_stats ON scan_source_stats;
CREATE TRIGGER tomb_upd_scan_source_stats BEFORE UPDATE OF job_id ON scan_source_stats FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_scan_source_stats();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_scheduler_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_scheduler_progress ON scheduler_progress;
CREATE TRIGGER tomb_upd_scheduler_progress BEFORE UPDATE OF tenant_id ON scheduler_progress FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_scheduler_progress();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_seo_audits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_seo_audits ON seo_audits;
CREATE TRIGGER tomb_upd_seo_audits BEFORE UPDATE OF tenant_id ON seo_audits FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_seo_audits();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_seo_briefs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_seo_briefs ON seo_briefs;
CREATE TRIGGER tomb_upd_seo_briefs BEFORE UPDATE OF tenant_id ON seo_briefs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_seo_briefs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_seo_index_configs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_seo_index_configs ON seo_index_configs;
CREATE TRIGGER tomb_upd_seo_index_configs BEFORE UPDATE OF tenant_id ON seo_index_configs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_seo_index_configs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_seo_index_keywords() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_seo_index_keywords ON seo_index_keywords;
CREATE TRIGGER tomb_upd_seo_index_keywords BEFORE UPDATE OF tenant_id ON seo_index_keywords FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_seo_index_keywords();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_seo_index_results() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_seo_index_results ON seo_index_results;
CREATE TRIGGER tomb_upd_seo_index_results BEFORE UPDATE OF tenant_id ON seo_index_results FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_seo_index_results();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_seo_index_runs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_seo_index_runs ON seo_index_runs;
CREATE TRIGGER tomb_upd_seo_index_runs BEFORE UPDATE OF tenant_id ON seo_index_runs FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_seo_index_runs();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_sequence_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_sequence_settings ON sequence_settings;
CREATE TRIGGER tomb_upd_sequence_settings BEFORE UPDATE OF tenant_id ON sequence_settings FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_sequence_settings();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_sequence_steps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_sequence_steps ON sequence_steps;
CREATE TRIGGER tomb_upd_sequence_steps BEFORE UPDATE OF tenant_id ON sequence_steps FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_sequence_steps();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_sequences() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_sequences ON sequences;
CREATE TRIGGER tomb_upd_sequences BEFORE UPDATE OF tenant_id ON sequences FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_sequences();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_sessions ON sessions;
CREATE TRIGGER tomb_upd_sessions BEFORE UPDATE OF user_id ON sessions FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_sessions();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_source_reviews() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_source_reviews ON source_reviews;
CREATE TRIGGER tomb_upd_source_reviews BEFORE UPDATE OF tenant_id ON source_reviews FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_source_reviews();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_stripe_ended_subscriptions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_stripe_ended_subscriptions ON stripe_ended_subscriptions;
CREATE TRIGGER tomb_upd_stripe_ended_subscriptions BEFORE UPDATE OF tenant_id ON stripe_ended_subscriptions FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_stripe_ended_subscriptions();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_suppressions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_suppressions ON suppressions;
CREATE TRIGGER tomb_upd_suppressions BEFORE UPDATE OF tenant_id ON suppressions FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_suppressions();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_system_mail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_system_mail_outbox ON system_mail_outbox;
CREATE TRIGGER tomb_upd_system_mail_outbox BEFORE UPDATE OF user_id ON system_mail_outbox FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_system_mail_outbox();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_tenant_competitors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_tenant_competitors ON tenant_competitors;
CREATE TRIGGER tomb_upd_tenant_competitors BEFORE UPDATE OF tenant_id ON tenant_competitors FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_tenant_competitors();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_tenant_connections() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_tenant_connections ON tenant_connections;
CREATE TRIGGER tomb_upd_tenant_connections BEFORE UPDATE OF tenant_id ON tenant_connections FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_tenant_connections();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_tenant_connectors() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_tenant_connectors ON tenant_connectors;
CREATE TRIGGER tomb_upd_tenant_connectors BEFORE UPDATE OF tenant_id ON tenant_connectors FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_tenant_connectors();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_tenant_llm_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_tenant_llm_keys ON tenant_llm_keys;
CREATE TRIGGER tomb_upd_tenant_llm_keys BEFORE UPDATE OF tenant_id ON tenant_llm_keys FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_tenant_llm_keys();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_tenant_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_tenant_memory ON tenant_memory;
CREATE TRIGGER tomb_upd_tenant_memory BEFORE UPDATE OF tenant_id ON tenant_memory FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_tenant_memory();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_tenant_plans() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_tenant_plans ON tenant_plans;
CREATE TRIGGER tomb_upd_tenant_plans BEFORE UPDATE OF tenant_id ON tenant_plans FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_tenant_plans();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_tenant_spend_pools() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_tenant_spend_pools ON tenant_spend_pools;
CREATE TRIGGER tomb_upd_tenant_spend_pools BEFORE UPDATE OF tenant_id ON tenant_spend_pools FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_tenant_spend_pools();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_tinyfish_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_tinyfish_usage ON tinyfish_usage;
CREATE TRIGGER tomb_upd_tinyfish_usage BEFORE UPDATE OF tenant_id ON tinyfish_usage FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_tinyfish_usage();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_trial_reservations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_trial_reservations ON trial_reservations;
CREATE TRIGGER tomb_upd_trial_reservations BEFORE UPDATE OF tenant_id ON trial_reservations FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_trial_reservations();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_trial_scans() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_trial_scans ON trial_scans;
CREATE TRIGGER tomb_upd_trial_scans BEFORE UPDATE OF tenant_id ON trial_scans FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_trial_scans();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_users ON users;
CREATE TRIGGER tomb_upd_users BEFORE UPDATE OF id ON users FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_users();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_warm_user_paths() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_warm_user_paths ON warm_user_paths;
CREATE TRIGGER tomb_upd_warm_user_paths BEFORE UPDATE OF tenant_id ON warm_user_paths FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_warm_user_paths();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_watch_seen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'watches' AND key = NEW.watch_id) OR NEW.watch_id IN (SELECT id FROM watches WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_watch_seen ON watch_seen;
CREATE TRIGGER tomb_upd_watch_seen BEFORE UPDATE OF watch_id ON watch_seen FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_watch_seen();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_watches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_watches ON watches;
CREATE TRIGGER tomb_upd_watches BEFORE UPDATE OF user_id ON watches FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_watches();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_work_queue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_work_queue ON work_queue;
CREATE TRIGGER tomb_upd_work_queue BEFORE UPDATE OF tenant_id ON work_queue FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_work_queue();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_users ON users;
CREATE TRIGGER tomb_users BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_users();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_warm_user_paths() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_warm_user_paths ON warm_user_paths;
CREATE TRIGGER tomb_warm_user_paths BEFORE INSERT ON warm_user_paths FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_warm_user_paths();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_watch_seen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstone_keys WHERE tbl = 'watches' AND key = NEW.watch_id) OR NEW.watch_id IN (SELECT id FROM watches WHERE user_id IN (SELECT deleted_tenant FROM tenant_tombstones))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_watch_seen ON watch_seen;
CREATE TRIGGER tomb_watch_seen BEFORE INSERT ON watch_seen FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_watch_seen();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_watches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.user_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_watches ON watches;
CREATE TRIGGER tomb_watches BEFORE INSERT ON watches FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_watches();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_work_queue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_work_queue ON work_queue;
CREATE TRIGGER tomb_work_queue BEFORE INSERT ON work_queue FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_work_queue();
