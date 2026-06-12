-- mu-001 (multi-user-isolation): users table for token-based identity.
--
-- Per PRD §5 + slice spec:
--   id              TEXT PK, generated as `cdx_<nanoid>` shape (e.g. cdx_aB12cD34)
--   name            TEXT UNIQUE NOT NULL — human label; admin chooses it
--   api_token_sha256 TEXT NOT NULL — sha256(plaintext_token); plaintext is
--                                       returned exactly once at mint and
--                                       never stored
--   label           TEXT NULL          — optional human note (e.g. "team alice")
--   created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
--   last_used_at    TIMESTAMPTZ NULL    — updated on every successful resolveToken
--   revoked_at      TIMESTAMPTZ NULL    — non-null = token retired (AP-3 + US-1.7)
--
-- AP-5: 'system' is a sentinel id for the SHARED_SECRET / DEMO_SECRET user
-- and is NOT a real row. The mintUser helper rejects name='system' before
-- INSERT, so the UNIQUE constraint is a belt-and-braces second line of
-- defense.
--
-- Idempotent. Safe to re-apply.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT         PRIMARY KEY,
  name            TEXT         NOT NULL UNIQUE,
  api_token_sha256 TEXT        NOT NULL,
  label           TEXT         NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ  NULL,
  revoked_at      TIMESTAMPTZ  NULL
);

-- Token lookup is by sha256 hash on every request — index it.
CREATE INDEX IF NOT EXISTS users_api_token_sha256_idx
  ON users (api_token_sha256)
  WHERE revoked_at IS NULL;

-- Last-used sort for the audit list (US-1.2).
CREATE INDEX IF NOT EXISTS users_last_used_at_idx
  ON users (last_used_at DESC NULLS LAST);
