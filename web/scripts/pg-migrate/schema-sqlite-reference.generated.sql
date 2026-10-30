CREATE TABLE acquisition_holds (
      tenant_id  TEXT NOT NULL,
      email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
      status     TEXT NOT NULL CHECK (status IN ('unverified_signup_hold','checkout_unpaid','signed_up','paid')),
      event_key  TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, email_hash)
    );

CREATE TABLE acquisition_lifecycle_events (
      event_key   TEXT PRIMARY KEY CHECK (length(event_key) <= 200),
      kind        TEXT NOT NULL CHECK (kind IN ('signup_unverified','signup_verified','checkout_unpaid','paid')),
      user_id     TEXT NOT NULL,
      email_hash  TEXT NOT NULL CHECK (length(email_hash) = 64),
      received_at INTEGER NOT NULL,
      applied_at  INTEGER
    );

CREATE TABLE advanced_consent (
    tenant_id TEXT NOT NULL, scope TEXT NOT NULL, version TEXT NOT NULL,
    accepted_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (tenant_id, scope)
  );

CREATE TABLE app_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    , generation INTEGER NOT NULL DEFAULT 0);

CREATE TABLE autopilot_audit (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT,
      message_id TEXT,
      action TEXT NOT NULL,
      detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE autopilot_settings (
      tenant_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT CHECK (pause_reason IS NULL OR length(pause_reason) <= 100),
      consent_version TEXT,
      consent_at INTEGER,
      daily_cap INTEGER NOT NULL DEFAULT 20 CHECK (daily_cap BETWEEN 1 AND 50)
    , followups_enabled INTEGER NOT NULL DEFAULT 0);

CREATE TABLE calcom_bookings (
      tenant_id      TEXT NOT NULL,
      booking_uid    TEXT NOT NULL,
      attendee_email TEXT NOT NULL,
      attendee_name  TEXT,
      lead_id        TEXT,
      created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, booking_uid)
    );

CREATE TABLE calcom_hooks (
      tenant_id  TEXT PRIMARY KEY,
      secret     TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE commenter_batches (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      context    TEXT NOT NULL CHECK (length(context) BETWEEN 1 AND 500),
      total      INTEGER NOT NULL,
      job_id     TEXT REFERENCES scan_jobs(id) ON DELETE SET NULL,
      note       TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE commenter_rows (
      id          TEXT PRIMARY KEY,
      batch_id    TEXT NOT NULL REFERENCES commenter_batches(id) ON DELETE CASCADE,
      profile_url TEXT NOT NULL CHECK (length(profile_url) BETWEEN 1 AND 500),
      slug        TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 100),
      name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 150),
      name_source TEXT NOT NULL CHECK (name_source IN ('csv','derived')),
      title       TEXT CHECK (title IS NULL OR length(title) <= 150),
      company     TEXT CHECK (company IS NULL OR length(company) <= 150),
      lead_id     TEXT REFERENCES leads(id) ON DELETE SET NULL,
      note        TEXT
    );

CREATE TABLE company_events (
      id                 TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL,
      company_key        TEXT NOT NULL CHECK (length(company_key) <= 254),
      company_name       TEXT CHECK (company_name IS NULL OR length(company_name) <= 200),
      scope              TEXT NOT NULL CHECK (scope IN ('account','market')),
      lead_id            TEXT,
      event_type         TEXT NOT NULL,
      summary            TEXT NOT NULL CHECK (length(summary) <= 300),
      detail             TEXT,
      source_url         TEXT NOT NULL CHECK (length(source_url) <= 500 AND source_url LIKE 'http%'),
      source_published_at TEXT CHECK (source_published_at IS NULL OR length(source_published_at) = 10),
      retrieved_at       INTEGER NOT NULL,
      first_seen_at      INTEGER NOT NULL,
      last_seen_at       INTEGER NOT NULL,
      confidence         INTEGER,
      UNIQUE (tenant_id, company_key, event_type, source_url)
    );

CREATE TABLE connector_audit (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      connector  TEXT NOT NULL,
      scan_job_id TEXT,
      lookup     TEXT NOT NULL CHECK (length(lookup) <= 200),
      status     TEXT NOT NULL,
      results    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    , insert_seq INTEGER);

CREATE TABLE consent_ledger (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      contact      TEXT NOT NULL,
      channel      TEXT NOT NULL CHECK (channel IN ('email','phone')),
      scope        TEXT NOT NULL CHECK (length(scope) <= 40),
      basis        TEXT NOT NULL CHECK (length(basis) <= 40),
      evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) <= 200),
      granted_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      revoked_at   INTEGER,
      revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 60)
    );

CREATE TABLE crm_push_claims (
      tenant_id   TEXT NOT NULL,
      destination TEXT NOT NULL,
      lead_id     TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'failed', 'uncertain', 'resolved_created', 'resolved_not_created')),
      external_id TEXT,
      attempt_id  TEXT NOT NULL,
      claimed_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, destination, lead_id)
    );

CREATE TABLE csv_batches (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      total      INTEGER NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE csv_rows (
      id       TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES csv_batches(id) ON DELETE CASCADE,
      domain   TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
      state    TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','skipped')),
      note     TEXT,
      job_id   TEXT REFERENCES scan_jobs(id) ON DELETE SET NULL
    );

CREATE TABLE email_candidates (
      tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, person TEXT NOT NULL CHECK (length(person) <= 120),
      address TEXT NOT NULL CHECK (length(address) <= 254), format TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified')),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), PRIMARY KEY (lead_id, address));

CREATE TABLE email_patterns (
      tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, site TEXT NOT NULL, format TEXT NOT NULL, support INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), PRIMARY KEY (lead_id, site));

CREATE TABLE evidence_purge_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (length(operator) BETWEEN 2 AND 120),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  copies_deleted INTEGER NOT NULL,
  bytes_deleted INTEGER NOT NULL,
  leads_unlinked INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE TABLE evidence_purge_gate (tenant_id TEXT PRIMARY KEY);

CREATE TABLE followup_messages (
      tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, step INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('sending','sent','uncertain')),
      gmail_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, thread_id, step)
    );

CREATE TABLE followup_threads (
      tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, lead_id TEXT NOT NULL, to_email TEXT NOT NULL, root_message_id TEXT NOT NULL,
      last_activity_at INTEGER NOT NULL, last_lead_reply_at INTEGER, followups_sent INTEGER NOT NULL DEFAULT 0, last_followup_at INTEGER,
      stopped TEXT CHECK (stopped IS NULL OR length(stopped) <= 40),
      PRIMARY KEY (tenant_id, thread_id)
    );

CREATE TABLE gmail_accounts (
      tenant_id    TEXT PRIMARY KEY,
      email        TEXT NOT NULL,
      refresh_ct   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconnect')),
      connected_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    , read_granted INTEGER NOT NULL DEFAULT 0);

CREATE TABLE hiring_feed_crawl (
    lead_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, company_key TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, claim TEXT
  );

CREATE TABLE inbound_messages (
      gmail_id TEXT NOT NULL, tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, lead_id TEXT, from_email TEXT NOT NULL,
      excerpt TEXT NOT NULL CHECK (length(excerpt) <= 200), classification TEXT NOT NULL, received_at INTEGER NOT NULL, outreach_message_id TEXT,
      PRIMARY KEY (tenant_id, gmail_id)
    );

CREATE TABLE inbox_thread_reads (tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, read_upto INTEGER NOT NULL, PRIMARY KEY (tenant_id, thread_id));

CREATE TABLE lead_enrichments (
      id          TEXT PRIMARY KEY,
      lead_id     TEXT NOT NULL,
      tenant_id   TEXT NOT NULL,
      connector   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      value       TEXT NOT NULL CHECK (length(value) <= 254),
      label       TEXT CHECK (label IS NULL OR length(label) <= 200),
      confidence  INTEGER,
      source_url  TEXT NOT NULL CHECK (length(source_url) <= 500 AND source_url LIKE 'http%'),
      source_date TEXT NOT NULL CHECK (length(source_date) = 10),
      retrieved_at INTEGER NOT NULL, insert_seq INTEGER,
      UNIQUE (lead_id, connector, kind, value)
    );

CREATE TABLE lead_evidence_copies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '' CHECK (length(CAST(title AS BLOB)) <= 1024),
  title_sha256 TEXT NOT NULL CHECK (length(title_sha256) = 64),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  text TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length <= 262144),
  fetched_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  expires_at INTEGER NOT NULL,
  UNIQUE (tenant_id, job_id, attempt, canonical_url)
);

CREATE TABLE lead_qualifications (
    tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, prompt_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
    vendor TEXT, model TEXT, served_model TEXT, result TEXT, usage TEXT, error TEXT, evidence TEXT,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    UNIQUE (tenant_id, lead_id, prompt_sha256));

CREATE TABLE lead_sources (
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      collector TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      PRIMARY KEY (lead_id, collector, attempt)
    );

CREATE TABLE leads (
      id          TEXT PRIMARY KEY,
      scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
      name        TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 150),
      company     TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 150),
      contact     TEXT CHECK (contact IS NULL OR length(contact) <= 254),
      signal      TEXT NOT NULL CHECK (length(signal) BETWEEN 1 AND 500),
      source_url  TEXT NOT NULL CHECK (length(source_url) <= 500 AND (source_url LIKE 'https://%' OR source_url LIKE 'http://%')),
      score       INTEGER NOT NULL DEFAULT 50 CHECK (score BETWEEN 0 AND 100),
      created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), stage TEXT, watch_new INTEGER NOT NULL DEFAULT 0, evidence_excerpt TEXT CHECK (evidence_excerpt IS NULL OR length(evidence_excerpt) <= 400), icp_match TEXT CHECK (icp_match IS NULL OR length(icp_match) <= 400), event_date TEXT, date_status TEXT CHECK (date_status IS NULL OR date_status IN ('verified','unverified','undated')), retrieved_at INTEGER, confidence INTEGER CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100), dedup_key TEXT, review_reason TEXT, evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin IN ('tinyfish_copy')), own_fetch_failure TEXT, evidence_copy_sha256 TEXT, evidence_purged_at INTEGER, timing_note TEXT CHECK (timing_note IS NULL OR length(timing_note) <= 300), published_at TEXT, evidence_copy_id TEXT, human_confirmed_at INTEGER, human_confirmed_from TEXT, company_domain TEXT CHECK (company_domain IS NULL OR length(company_domain) <= 253), quarantined_at INTEGER, quarantine_reason TEXT CHECK (quarantine_reason IS NULL OR length(quarantine_reason) <= 300), fit INTEGER CHECK (fit IS NULL OR fit BETWEEN 0 AND 5), intent INTEGER CHECK (intent IS NULL OR intent BETWEEN 0 AND 5), action INTEGER CHECK (action IS NULL OR action BETWEEN 0 AND 5), why TEXT CHECK (why IS NULL OR length(why) <= 600), signals TEXT CHECK (signals IS NULL OR length(signals) <= 1000), seen_before INTEGER NOT NULL DEFAULT 0, signal_kind TEXT, source_kind TEXT, insert_seq INTEGER,
      CHECK (name <> '' OR company <> '')
    );

CREATE TABLE lifecycle_events (
    kind TEXT NOT NULL CHECK (kind IN ('signup','payment_succeeded','payment_failed','refund','subscription_ended')),
    ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 200),
    tenant_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    amount_cents INTEGER,
    invoice TEXT,
    full_refund INTEGER,
    source TEXT CHECK (source IS NULL OR length(source) <= 40),
    PRIMARY KEY (kind, ref)
  );

CREATE TABLE mail_read_consent (tenant_id TEXT PRIMARY KEY, version TEXT NOT NULL, accepted_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)));

CREATE TABLE memberships (
    tenant_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
    created_at INTEGER NOT NULL,
    added_by TEXT,
    PRIMARY KEY (tenant_id, member_id)
  );

CREATE TABLE monitor_runs (
      id         TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      job_id     TEXT NOT NULL,
      ran_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      processed  INTEGER NOT NULL DEFAULT 0,
      new_count  INTEGER
    );

CREATE TABLE monitor_seen (
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      dedup_key  TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (monitor_id, dedup_key)
    );

CREATE TABLE monitors (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      query          TEXT NOT NULL CHECK (length(query) BETWEEN 3 AND 600),
      icp            TEXT,
      sources        TEXT,
      interval_hours INTEGER NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      paused_reason  TEXT,
      last_run_at    INTEGER,
      next_run_at    INTEGER,
      created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE newsjacks (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      url        TEXT NOT NULL CHECK (length(url) <= 500),
      title      TEXT,
      draft      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE oauth_identities (
    provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (provider, subject)
  );

CREATE TABLE oauth_states (
      state_hash TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      verifier   TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    , read_scope INTEGER NOT NULL DEFAULT 0);

CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 150),
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE outreach_llm_usage (
      id            INTEGER PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      message_id    TEXT,
      purpose       TEXT NOT NULL,
      vendor        TEXT,
      requested_model TEXT,
      model         TEXT,
      request_id    TEXT,
      outcome       TEXT NOT NULL,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE outreach_messages (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      lead_id        TEXT NOT NULL,
      to_email       TEXT NOT NULL,
      subject        TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 150),
      body           TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 3000),
      status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','skipped','uncertain')),
      approved_hash  TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      claimed_at     INTEGER,
      sent_at        INTEGER,
      gmail_id       TEXT,
      error          TEXT CHECK (error IS NULL OR length(error) <= 200),
      created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), thread_id TEXT, test INTEGER NOT NULL DEFAULT 0, insert_seq INTEGER,
      UNIQUE (tenant_id, lead_id)
    );

CREATE TABLE outreach_settings (
      tenant_id      TEXT PRIMARY KEY,
      sender_name    TEXT NOT NULL CHECK (length(sender_name) BETWEEN 1 AND 100),
      postal_address TEXT NOT NULL CHECK (length(postal_address) BETWEEN 10 AND 300)
    , booking_url TEXT);

CREATE TABLE outreach_signal_context (
    message_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    scan_job_id TEXT NOT NULL,
    signal TEXT,
    signals_json TEXT,
    signal_kind TEXT,
    source_kind TEXT,
    source_url TEXT,
    collectors_json TEXT,
    captured_at INTEGER NOT NULL
  );

CREATE TABLE rate_limits (
      key TEXT PRIMARY KEY CHECK (length(key) <= 300),
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );

CREATE TABLE reopen_messages (
      tenant_id  TEXT NOT NULL,
      thread_id  TEXT NOT NULL,
      lead_id    TEXT NOT NULL,
      to_email   TEXT NOT NULL,
      body       TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 3000),
      status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','skipped')),
      gmail_id   TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      sent_at    INTEGER,
      PRIMARY KEY (tenant_id, thread_id)
    );

CREATE TABLE reply_drafts (
      thread_id  TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      draft      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','edited','copied','posted')),
      updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE reply_queries (
      tenant_id  TEXT NOT NULL,
      query      TEXT NOT NULL,
      position   INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, query)
    );

CREATE TABLE reply_threads (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      platform     TEXT NOT NULL CHECK (platform IN ('reddit','x')),
      url          TEXT NOT NULL,
      title        TEXT NOT NULL,
      quote        TEXT NOT NULL,
      query        TEXT NOT NULL,
      date         TEXT,
      login_walled INTEGER NOT NULL DEFAULT 0,
      buyer_intent TEXT CHECK (buyer_intent IS NULL OR buyer_intent IN ('yes','no','uncertain')),
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      UNIQUE (tenant_id, url)
    );

CREATE TABLE scan_jobs (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
      business_name TEXT NOT NULL CHECK (length(business_name) BETWEEN 1 AND 150),
      industry      TEXT NOT NULL CHECK (length(industry) BETWEEN 1 AND 100),
      location      TEXT NOT NULL CHECK (length(location) BETWEEN 1 AND 100),
      attempts      INTEGER NOT NULL DEFAULT 0,
      error         TEXT CHECK (error IS NULL OR length(error) <= 200),
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      claimed_at    INTEGER,
      finished_at   INTEGER
    , funded_by TEXT NOT NULL DEFAULT 'user', seller TEXT, offer TEXT CHECK (offer IS NULL OR length(offer) <= 150), offer_set_at INTEGER, watch_id TEXT, candidates INTEGER, needs_review INTEGER, dropped INTEGER, run_budget TEXT, spend_reserved_usd REAL, drop_reasons TEXT, verified INTEGER, query TEXT CHECK (query IS NULL OR length(query) <= 600), icp TEXT CHECK (icp IS NULL OR length(icp) <= 4000), icp_inferred INTEGER, sources TEXT CHECK (sources IS NULL OR length(sources) <= 2000), csv_domain TEXT CHECK (csv_domain IS NULL OR length(csv_domain) <= 253), batch_id TEXT, enrich_started_at INTEGER, enrich_finished_at INTEGER, insert_seq INTEGER);

CREATE TABLE scan_model_calls (
    tenant_id TEXT NOT NULL,
    job_id TEXT REFERENCES scan_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    stage TEXT NOT NULL CHECK (length(stage) <= 40),
    method TEXT NOT NULL,
    model_requested TEXT CHECK (model_requested IS NULL OR length(model_requested) <= 100),
    model_served TEXT CHECK (model_served IS NULL OR length(model_served) <= 100),
    input_tokens INTEGER,
    output_tokens INTEGER,
    outcome TEXT NOT NULL,
    max_tokens INTEGER,
    prompt_chars INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  );

CREATE TABLE scan_run_report (
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    report TEXT NOT NULL CHECK (length(report) <= 120000),
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (job_id, attempt)
  );

CREATE TABLE scan_source_runs (
      job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      collector TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_count INTEGER,
      candidate_count INTEGER,
      verified_count INTEGER,
      review_count INTEGER,
      inserted_count INTEGER NOT NULL,
      PRIMARY KEY (job_id, attempt, collector)
    );

CREATE TABLE scan_source_stats (
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    collector TEXT NOT NULL,
    queries TEXT CHECK (queries IS NULL OR length(queries) <= 2000),
    query_source TEXT CHECK (query_source IS NULL OR query_source IN ('model','fallback')),
    searches_attempted INTEGER,
    searches_ok INTEGER,
    searches_failed TEXT CHECK (searches_failed IS NULL OR length(searches_failed) <= 200),
    searches_not_attempted TEXT CHECK (searches_not_attempted IS NULL OR length(searches_not_attempted) <= 200),
    hits_raw INTEGER,
    hits_unique_urls INTEGER,
    hits_complete INTEGER CHECK (hits_complete IS NULL OR hits_complete IN (0,1)),
    fetch_complete INTEGER CHECK (fetch_complete IS NULL OR fetch_complete IN (0,1)),
    fetch_requested INTEGER,
    fetch_outcome TEXT CHECK (fetch_outcome IS NULL OR length(fetch_outcome) <= 40),
    fetch_pages_with_text INTEGER,
    per_query TEXT CHECK (per_query IS NULL OR length(per_query) <= 4000),
    distinct_hosts INTEGER,
    urls_not_fetched INTEGER,
    extracted_candidates INTEGER,
    model_requested TEXT CHECK (model_requested IS NULL OR length(model_requested) <= 100),
    model_served TEXT CHECK (model_served IS NULL OR length(model_served) <= 100),
    model_calls INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    evidence_items INTEGER,
    evidence_with_page_text INTEGER,
    evidence_snippet_only INTEGER,
    PRIMARY KEY (job_id, attempt, collector)
  );

CREATE TABLE seo_audits (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, domain TEXT NOT NULL,
    results TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  );

CREATE TABLE seo_briefs (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      topic      TEXT NOT NULL CHECK (length(topic) BETWEEN 3 AND 300),
      brief      TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE seo_index_configs (
      tenant_id   TEXT PRIMARY KEY,
      domain      TEXT NOT NULL,
      next_run_at INTEGER
    );

CREATE TABLE seo_index_keywords (
      tenant_id  TEXT NOT NULL,
      keyword    TEXT NOT NULL CHECK (length(keyword) BETWEEN 1 AND 120),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, keyword)
    );

CREATE TABLE seo_index_results (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      keyword    TEXT NOT NULL,
      indexed    INTEGER NOT NULL,
      top_url    TEXT,
      checked_at INTEGER NOT NULL
    );

CREATE TABLE seo_index_runs (
      tenant_id TEXT NOT NULL,
      ran_at    INTEGER NOT NULL,
      searches  INTEGER NOT NULL
    );

CREATE TABLE sequence_settings (
      tenant_id      TEXT PRIMARY KEY,
      test_addresses TEXT NOT NULL DEFAULT '[]'
    );

CREATE TABLE sequence_steps (
      tenant_id     TEXT NOT NULL,
      sequence_id   TEXT NOT NULL,
      step          INTEGER NOT NULL CHECK (step BETWEEN 1 AND 3),
      subject       TEXT NOT NULL,
      body          TEXT NOT NULL,
      approved_hash TEXT,
      status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sending','sent','uncertain')),
      gmail_id      TEXT,
      claimed_at    INTEGER,
      sent_at       INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, sequence_id, step)
    );

CREATE TABLE sequences (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      lead_id     TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      to_email    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','active','replied','done','stopped')),
      stop_reason TEXT CHECK (stop_reason IS NULL OR length(stop_reason) <= 40),
      created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      UNIQUE (tenant_id, lead_id)
    );

CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    , active_tenant_id TEXT);

CREATE TABLE source_reviews (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, lead_id TEXT NOT NULL,
 input_json TEXT NOT NULL, fetch_status TEXT NOT NULL, quote_match INTEGER NOT NULL,
 company_named INTEGER NOT NULL, contact_match INTEGER NOT NULL, checked_at INTEGER NOT NULL
 );

CREATE TABLE stripe_ended_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      ended_at INTEGER
    );

CREATE TABLE stripe_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      processed_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE suppressions (
      tenant_id  TEXT NOT NULL,
      email      TEXT NOT NULL,
      reason     TEXT NOT NULL CHECK (reason IN ('unsubscribe','manual','bounce')),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, email)
    );

CREATE TABLE tenant_competitors (
    tenant_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, name)
  );

CREATE TABLE tenant_connections (
      tenant_id    TEXT NOT NULL,
      name         TEXT NOT NULL CHECK (length(name) <= 200),
      linkedin_url TEXT NOT NULL,
      company      TEXT CHECK (company IS NULL OR length(company) <= 200),
      position     TEXT CHECK (position IS NULL OR length(position) <= 200),
      connected_on TEXT CHECK (connected_on IS NULL OR length(connected_on) <= 20),
      imported_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, linkedin_url)
    );

CREATE TABLE tenant_connectors (
      tenant_id    TEXT NOT NULL,
      connector    TEXT NOT NULL,
      ciphertext   TEXT NOT NULL,
      last4        TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, connector)
    );

CREATE TABLE tenant_llm_keys (
      tenant_id    TEXT NOT NULL,
      vendor       TEXT NOT NULL CHECK (vendor IN ('anthropic','openai')),
      ciphertext   TEXT NOT NULL,
      last4        TEXT NOT NULL,
      validated_at INTEGER NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, vendor)
    );

CREATE TABLE tenant_memory (
      tenant_id   TEXT PRIMARY KEY,
      icp         TEXT NOT NULL DEFAULT '' CHECK (length(icp) <= 600),
      positioning TEXT NOT NULL DEFAULT '' CHECK (length(positioning) <= 600),
      tone        TEXT NOT NULL DEFAULT '' CHECK (length(tone) <= 200),
      exclusions  TEXT NOT NULL DEFAULT '[]',
      objections  TEXT NOT NULL DEFAULT '[]',
      updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE tenant_plans (
      tenant_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT
    , stripe_event_at INTEGER, stripe_reconcile_at INTEGER, subscription_status TEXT);

CREATE TABLE tenant_spend_pools (
    tenant_id TEXT NOT NULL, period TEXT NOT NULL CHECK (length(period) <= 12),
    reserved_usd REAL NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0), reported_usd REAL NOT NULL DEFAULT 0 CHECK (reported_usd >= 0),
    calls INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, period)
  );

CREATE TABLE tinyfish_usage (day TEXT NOT NULL, tenant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('search','fetch')), n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, tenant_id, kind));

CREATE TABLE trial_budget_lock (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0);

CREATE TABLE trial_reservations (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      job_id      TEXT,
      reserve_usd REAL NOT NULL CHECK (reserve_usd > 0),
      day         INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      settled_at  INTEGER,
      settled_attempt INTEGER
    );

CREATE TABLE trial_scans (
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );

CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      business_name TEXT,
      sells TEXT,
      website TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    , buyer_profile TEXT);

CREATE TABLE warm_user_paths (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      lead_id      TEXT NOT NULL,
      contact_url  TEXT NOT NULL,
      mutual_name  TEXT NOT NULL CHECK (length(mutual_name) <= 200),
      note         TEXT CHECK (note IS NULL OR length(note) <= 500),
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), insert_seq INTEGER,
      UNIQUE (tenant_id, lead_id, contact_url, mutual_name)
    );

CREATE TABLE watch_seen (
    watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    seen_key   TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (watch_id, seen_key)
  );

CREATE TABLE watches (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    query       TEXT NOT NULL,
    icp         TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    paused_reason TEXT,
    created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  , run_budget TEXT);

CREATE TABLE work_queue (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        not_before INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        lease_expires_at INTEGER,
        claim_token INTEGER,
        last_error TEXT,
        dedupe_key TEXT
      );

CREATE TABLE work_queue_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);

CREATE INDEX acquisition_lifecycle_events_hash ON acquisition_lifecycle_events (email_hash);

CREATE INDEX acquisition_lifecycle_events_pending ON acquisition_lifecycle_events (applied_at);

CREATE INDEX autopilot_audit_tenant ON autopilot_audit (tenant_id, created_at);

CREATE INDEX commenter_batches_user ON commenter_batches (user_id, created_at);

CREATE INDEX commenter_rows_batch ON commenter_rows (batch_id);

CREATE INDEX company_events_company ON company_events (tenant_id, company_key);

CREATE INDEX company_events_tenant ON company_events (tenant_id, last_seen_at);

CREATE INDEX connector_audit_insert_seq_idx ON connector_audit (insert_seq);

CREATE INDEX connector_audit_tenant ON connector_audit (tenant_id, created_at);

CREATE INDEX consent_ledger_lookup ON consent_ledger (tenant_id, contact, channel, scope);

CREATE INDEX csv_batches_user ON csv_batches (user_id, created_at);

CREATE INDEX csv_rows_batch ON csv_rows (batch_id);

CREATE UNIQUE INDEX hiring_feed_crawl_company ON hiring_feed_crawl(tenant_id, company_key);

CREATE INDEX hiring_feed_crawl_job ON hiring_feed_crawl(tenant_id, job_id);

CREATE INDEX idx_evidence_copies_tenant ON lead_evidence_copies(tenant_id, expires_at);

CREATE INDEX inbound_messages_thread ON inbound_messages (tenant_id, thread_id, received_at);

CREATE INDEX lead_enrichments_insert_seq_idx ON lead_enrichments (insert_seq);

CREATE INDEX lead_enrichments_lead ON lead_enrichments (lead_id);

CREATE UNIQUE INDEX lead_qualifications_one_per_lead ON lead_qualifications (tenant_id, lead_id);

CREATE UNIQUE INDEX leads_dedup ON leads (scan_job_id, dedup_key) WHERE dedup_key IS NOT NULL;

CREATE INDEX leads_insert_seq_idx ON leads (insert_seq);

CREATE INDEX leads_job ON leads (scan_job_id);

CREATE INDEX lifecycle_events_tenant ON lifecycle_events (tenant_id, kind);

CREATE INDEX memberships_member ON memberships (member_id);

CREATE INDEX monitor_runs_monitor ON monitor_runs (monitor_id, ran_at);

CREATE INDEX monitors_due ON monitors (enabled, next_run_at);

CREATE INDEX newsjacks_tenant ON newsjacks (tenant_id, created_at);

CREATE INDEX outreach_messages_insert_seq_idx ON outreach_messages (insert_seq);

CREATE INDEX outreach_tenant ON outreach_messages (tenant_id, status);

CREATE INDEX rate_limits_reset ON rate_limits (reset_at);

CREATE INDEX reply_threads_tenant ON reply_threads (tenant_id, created_at);

CREATE INDEX scan_jobs_insert_seq_idx ON scan_jobs (insert_seq);

CREATE INDEX scan_jobs_status ON scan_jobs (status, created_at);

CREATE INDEX scan_jobs_user ON scan_jobs (user_id, created_at);

CREATE UNIQUE INDEX scan_model_calls_job ON scan_model_calls(job_id, attempt, seq);

CREATE INDEX seo_briefs_tenant ON seo_briefs (tenant_id, created_at);

CREATE INDEX seo_index_results_tenant ON seo_index_results (tenant_id, keyword, checked_at);

CREATE INDEX sequences_tenant ON sequences (tenant_id, status);

CREATE INDEX source_reviews_tenant ON source_reviews(tenant_id,lead_id);

CREATE INDEX tenant_connections_tenant ON tenant_connections (tenant_id);

CREATE INDEX tenant_plans_customer ON tenant_plans (stripe_customer_id);

CREATE INDEX trial_reservations_day ON trial_reservations (day, tenant_id);

CREATE INDEX trial_scans_ip ON trial_scans (ip_hash, created_at);

CREATE INDEX trial_scans_tenant ON trial_scans (tenant_id, created_at);

CREATE INDEX warm_user_paths_insert_seq_idx ON warm_user_paths (insert_seq);

CREATE INDEX warm_user_paths_lead ON warm_user_paths (tenant_id, lead_id);

CREATE INDEX watches_due ON watches (active, next_run_at);

CREATE INDEX work_queue_claimable
        ON work_queue(status, not_before, created_at);

CREATE UNIQUE INDEX work_queue_dedupe
        ON work_queue(tenant_id, kind, dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed');

CREATE TRIGGER connector_audit_insert_seq AFTER INSERT ON connector_audit WHEN NEW.insert_seq IS NULL BEGIN UPDATE connector_audit SET insert_seq = (SELECT coalesce(max(insert_seq), 0) + 1 FROM connector_audit) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER evidence_purge_audit_no_delete BEFORE DELETE ON evidence_purge_audit BEGIN SELECT RAISE(ABORT, 'purge audit is append-only'); END;

CREATE TRIGGER evidence_purge_audit_no_update BEFORE UPDATE ON evidence_purge_audit BEGIN SELECT RAISE(ABORT, 'purge audit is append-only'); END;

CREATE TRIGGER lead_enrichments_insert_seq AFTER INSERT ON lead_enrichments WHEN NEW.insert_seq IS NULL BEGIN UPDATE lead_enrichments SET insert_seq = (SELECT coalesce(max(insert_seq), 0) + 1 FROM lead_enrichments) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER lead_evidence_copies_delete_only_expired BEFORE DELETE ON lead_evidence_copies
  WHEN OLD.expires_at > CAST(strftime('%s','now') AS INTEGER)
   AND NOT EXISTS (SELECT 1 FROM evidence_purge_gate g WHERE g.tenant_id = OLD.tenant_id)
  BEGIN SELECT RAISE(ABORT, 'evidence copy is still within its retention period'); END;

CREATE TRIGGER lead_evidence_copies_no_update BEFORE UPDATE ON lead_evidence_copies
  BEGIN SELECT RAISE(ABORT, 'evidence copies are immutable'); END;

CREATE TRIGGER leads_insert_seq AFTER INSERT ON leads WHEN NEW.insert_seq IS NULL BEGIN UPDATE leads SET insert_seq = (SELECT coalesce(max(insert_seq), 0) + 1 FROM leads) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER leads_only_while_running
    BEFORE INSERT ON leads
    WHEN (SELECT status FROM scan_jobs WHERE id = NEW.scan_job_id) IS NOT 'running'
    BEGIN SELECT RAISE(ABORT, 'leads can only be added to a running job'); END;

CREATE TRIGGER outreach_messages_insert_seq AFTER INSERT ON outreach_messages WHEN NEW.insert_seq IS NULL BEGIN UPDATE outreach_messages SET insert_seq = (SELECT coalesce(max(insert_seq), 0) + 1 FROM outreach_messages) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER outreach_sent_is_final
    BEFORE UPDATE OF status ON outreach_messages
    WHEN OLD.status IN ('sent','skipped') AND NEW.status <> OLD.status
    BEGIN SELECT RAISE(ABORT, 'final outreach status'); END;

CREATE TRIGGER scan_jobs_insert_seq AFTER INSERT ON scan_jobs WHEN NEW.insert_seq IS NULL BEGIN UPDATE scan_jobs SET insert_seq = (SELECT coalesce(max(insert_seq), 0) + 1 FROM scan_jobs) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER scan_jobs_transitions
    BEFORE UPDATE OF status ON scan_jobs
    WHEN NOT (
      (OLD.status = 'pending' AND NEW.status = 'running') OR
      (OLD.status = 'running' AND NEW.status IN ('done','failed','pending')) OR
      OLD.status = NEW.status
    )
    BEGIN SELECT RAISE(ABORT, 'illegal scan job status transition'); END;

CREATE TRIGGER sequence_sent_final
    BEFORE UPDATE ON sequence_steps
    WHEN OLD.status = 'sent' AND (NEW.status <> 'sent' OR NEW.subject <> OLD.subject OR NEW.body <> OLD.body)
    BEGIN SELECT RAISE(ABORT, 'sent sequence step is final'); END;

CREATE TRIGGER warm_user_paths_insert_seq AFTER INSERT ON warm_user_paths WHEN NEW.insert_seq IS NULL BEGIN UPDATE warm_user_paths SET insert_seq = (SELECT coalesce(max(insert_seq), 0) + 1 FROM warm_user_paths) WHERE rowid = NEW.rowid; END;
