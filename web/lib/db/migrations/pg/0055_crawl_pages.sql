-- crawl_pages (#871): one row per page the site crawler fetched, with URL and fetch time.
-- The durable per-page record the bounded crawl leaves behind; later source-cited extraction (#872/#873) reads it.
CREATE TABLE IF NOT EXISTS crawl_pages (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      scan_job_id TEXT NOT NULL,
      site        TEXT NOT NULL,
      url         TEXT NOT NULL CHECK (char_length(url) <= 500 AND lower(url) LIKE lower('http%')),
      status      BIGINT NOT NULL,
      fetched_at  BIGINT NOT NULL,
      UNIQUE (tenant_id, scan_job_id, site, url)
    );

CREATE INDEX IF NOT EXISTS crawl_pages_job ON crawl_pages (scan_job_id);

CREATE OR REPLACE FUNCTION dazl_guard_tomb_crawl_pages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  IF (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_crawl_pages ON crawl_pages;
CREATE TRIGGER tomb_crawl_pages BEFORE INSERT ON crawl_pages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_crawl_pages();

CREATE OR REPLACE FUNCTION dazl_guard_tomb_upd_crawl_pages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext(NEW.tenant_id));
  PERFORM pg_advisory_xact_lock_shared(hashtext(OLD.tenant_id));
  IF (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND ((EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = NEW.tenant_id)) OR (EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = OLD.tenant_id)))) THEN RAISE EXCEPTION 'tenant deleted'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tomb_upd_crawl_pages ON crawl_pages;
CREATE TRIGGER tomb_upd_crawl_pages BEFORE UPDATE OF tenant_id ON crawl_pages FOR EACH ROW EXECUTE FUNCTION dazl_guard_tomb_upd_crawl_pages();
