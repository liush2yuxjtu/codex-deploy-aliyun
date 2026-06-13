-- mu-006 (multi-user-isolation): pdf_jobs table for per-user PDF audit.
--
-- Per PRD §4.4 + slice spec:
--   pdf_slug     TEXT PK           -- the human-meaningful slug
--   user_id      TEXT NOT NULL     -- who created this PDF; references users(id)
--                                    -- sentinel 'system' allowed for legacy
--                                    -- backfill rows (boot-time migration
--                                    -- moves loose <slug>.pdf into system/)
--   kind         TEXT NOT NULL     -- 'from-url' | 'from-upload' | 'from-convert'
--   source       TEXT NOT NULL     -- URL or local path the renderer read
--   oss_key      TEXT NULL         -- set once OSS upload succeeds
--   size_bytes   BIGINT NULL       -- set once the binary is written
--   created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
--   last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
--
-- pdf_slug is per-user unique via the composite PRIMARY KEY (user_id,
-- pdf_slug) — so a second hit on the same slug from the SAME user
-- re-uses the row (ON CONFLICT (user_id, pdf_slug) DO UPDATE bumps
-- last_seen) rather than erroring out. The composite semantics is
-- "every (slug, user_id) pair is unique; if you see a slug that
-- already exists for this user, just touch it." Two different users
-- may legitimately pick the same slug — those rows coexist under the
-- composite PK without overwriting each other.
--
-- Used for:
--   - admin stats endpoint (US-1.4) — counts per user
--   - server-restart re-presign (US-3.2) — OSS_URL_CACHE miss → DB hit
--   - per-user disk-usage audit (US-3.7)
--
-- Idempotent. Safe to re-apply.

CREATE TABLE IF NOT EXISTS pdf_jobs (
  pdf_slug     TEXT         NOT NULL,
  user_id      TEXT         NOT NULL,
  kind         TEXT         NOT NULL,
  source       TEXT         NOT NULL,
  oss_key      TEXT         NULL,
  size_bytes   BIGINT       NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pdf_slug)
);

-- Hot path lookup is `(user_id, slug)` → row, used by handlePdfOss on
-- cache miss. Index also serves the per-user audit count + sort.
CREATE INDEX IF NOT EXISTS pdf_jobs_user_id_idx
  ON pdf_jobs (user_id, created_at DESC);
