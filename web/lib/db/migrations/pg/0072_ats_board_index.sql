-- ATS board index (Refs #1122): public board slugs from Common Crawl or past leads, stored as data; global, not tenant data.

CREATE TABLE ats_boards (
      kind TEXT NOT NULL CHECK (kind IN ('ashby','greenhouse','lever')),
      slug TEXT NOT NULL,
      source TEXT NOT NULL,
      first_seen BIGINT NOT NULL,
      last_polled BIGINT,
      next_poll BIGINT NOT NULL DEFAULT 0,
      poll_status TEXT,
      company TEXT,
      website TEXT,
      PRIMARY KEY (kind, slug)
    );

CREATE TABLE ats_index_cursor (
      crawl TEXT NOT NULL,
      pattern TEXT NOT NULL,
      pages BIGINT,
      next_page BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (crawl, pattern)
    );

CREATE INDEX ats_boards_next_poll ON ats_boards(next_poll);
