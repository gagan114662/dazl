-- #366: revenue pipeline (lib/pipeline/tables.ts, lib/pipeline/deals.ts). deals holds one canonical deal per qualified
-- conversation (UNIQUE tenant_id, thread_id); deal_stage_events is its append-only history, one full snapshot per change
-- (UPDATE refused), so any past state is reconstructable; deal_routing_rules picks the owner of a newly routed deal.
-- Tomb guards per 0039, copied from the regenerated schema-full.generated.sql.
CREATE TABLE deal_routing_rules (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      position    BIGINT NOT NULL CHECK (position >= 1),
      match_kind  TEXT NOT NULL CHECK (match_kind IN ('any', 'play', 'domain')),
      match_value TEXT NOT NULL CHECK (char_length(match_value) <= 200),
      owner_id    TEXT NOT NULL,
      sla_hours   BIGINT CHECK (sla_hours IS NULL OR (sla_hours >= 1 AND sla_hours <= 720)),
      active      BIGINT NOT NULL CHECK (active IN (1, 0)),
      created_by  TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    );

CREATE TABLE deal_stage_events (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      deal_id      TEXT NOT NULL,
      seq          BIGINT NOT NULL CHECK (seq >= 1),
      kind         TEXT NOT NULL CHECK (kind IN ('created', 'changed', 'closed', 'reopened')),
      from_stage   TEXT CHECK (from_stage IS NULL OR char_length(from_stage) <= 20),
      stage        TEXT NOT NULL CHECK (stage IN ('new', 'qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost')),
      owner_id     TEXT,
      amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
      currency     TEXT CHECK (currency IS NULL OR char_length(currency) = 3),
      close_reason TEXT CHECK (close_reason IS NULL OR char_length(close_reason) <= 40),
      actor_id     TEXT NOT NULL CHECK (char_length(actor_id) <= 80),
      at           BIGINT NOT NULL,
      UNIQUE (tenant_id, deal_id, seq)
    );

CREATE TABLE deals (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      thread_id    TEXT NOT NULL CHECK (char_length(thread_id) <= 200),
      lead_id      TEXT NOT NULL,
      title        TEXT NOT NULL CHECK (char_length(title) <= 200),
      owner_id     TEXT,
      stage        TEXT NOT NULL CHECK (stage IN ('new', 'qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost')),
      amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
      currency     TEXT CHECK (currency IS NULL OR char_length(currency) = 3),
      close_date   TEXT CHECK (close_date IS NULL OR char_length(close_date) = 10),
      close_reason TEXT CHECK (close_reason IS NULL OR char_length(close_reason) <= 40),
      close_note   TEXT CHECK (close_note IS NULL OR char_length(close_note) <= 200),
      rule_id      TEXT,
      route_reason TEXT NOT NULL CHECK (char_length(route_reason) <= 40),
      sla_due_at   BIGINT,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL,
      closed_at    BIGINT,
      version      BIGINT NOT NULL CHECK (version >= 1),
      UNIQUE (tenant_id, thread_id)
    );


CREATE INDEX deal_routing_rules_tenant ON deal_routing_rules (tenant_id, active, position);

CREATE INDEX deal_stage_events_tenant_at ON deal_stage_events (tenant_id, at);

CREATE INDEX deals_tenant_stage ON deals (tenant_id, stage);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_deal_routing_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_deal_routing_rules ON deal_routing_rules;
CREATE TRIGGER tomb_deal_routing_rules BEFORE INSERT ON deal_routing_rules FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_deal_routing_rules();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_deal_stage_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_deal_stage_events ON deal_stage_events;
CREATE TRIGGER tomb_deal_stage_events BEFORE INSERT ON deal_stage_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_deal_stage_events();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_deals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_deals ON deals;
CREATE TRIGGER tomb_deals BEFORE INSERT ON deals FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_deals();


CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_deal_routing_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_deal_routing_rules ON deal_routing_rules;
CREATE TRIGGER tomb_upd_deal_routing_rules BEFORE UPDATE OF tenant_id ON deal_routing_rules FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_deal_routing_rules();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_deal_stage_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_deal_stage_events ON deal_stage_events;
CREATE TRIGGER tomb_upd_deal_stage_events BEFORE UPDATE OF tenant_id ON deal_stage_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_deal_stage_events();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_deals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_deals ON deals;
CREATE TRIGGER tomb_upd_deals BEFORE UPDATE OF tenant_id ON deals FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_deals();


CREATE OR REPLACE FUNCTION dazl_guard_deal_stage_events_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TRUE) THEN RAISE EXCEPTION 'deal history is append-only'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deal_stage_events_no_update ON deal_stage_events;
CREATE TRIGGER deal_stage_events_no_update BEFORE UPDATE ON deal_stage_events FOR EACH ROW EXECUTE FUNCTION dazl_guard_deal_stage_events_no_update();
