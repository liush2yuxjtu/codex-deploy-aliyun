-- mu-006 follow-up (multi-user-isolation): pdf_jobs composite PK
-- ALTER for prod.
--
-- Per bug-011: migration 006_pdf_jobs.sql declares
--   PRIMARY KEY (user_id, pdf_slug)
-- but prod's pdf_jobs was created earlier with the old single-column
-- PRIMARY KEY (pdf_slug) — the CREATE TABLE IF NOT EXISTS in 006 is a
-- no-op on the existing table, so the on-disk schema in prod still
-- has the old PK. recordPdfJob's ON CONFLICT (user_id, pdf_slug) (bug-
-- 012) now matches the new schema, so this ALTER is safe to apply.
--
-- Idempotent: each step is a no-op when the desired shape is already
-- in place. Safe to re-apply.
--
-- Steps:
--   1. Drop the existing single-column PK (named pdf_jobs_pkey by
--      Postgres default, but we look it up via pg_constraint so the
--      ALTER works even if the constraint was renamed manually).
--   2. Add the composite PRIMARY KEY (user_id, pdf_slug).
--   3. Touch every existing row's last_seen so the migration is
--      observably visible in the audit log, not silently applied.
--
-- Risk:
--   - DROP + ADD PK is O(1) metadata change. Postgres reuses the
--     existing pdf_jobs_user_id_idx for the new PK (the index leads
--     with user_id which is the new PK's leading column).
--   - If any duplicate (user_id, pdf_slug) pair exists, ADD PK will
--     fail loudly — good failure mode, the deploy will halt and
--     surface the conflict.

DO $$
DECLARE
  pk_constraint_name TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'pdf_jobs'
  ) THEN
    RAISE NOTICE 'pdf_jobs table not present yet — migration 008 is a no-op (006 will create it with the correct composite PK)';
    RETURN;
  END IF;

  -- 1. Drop the existing PK if there is one and it is NOT already the
  --    composite shape we want. Look the name up via pg_constraint so
  --    the ALTER is robust to manual renames.
  SELECT c.conname
    INTO pk_constraint_name
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE c.contype = 'p'
     AND c.conrelid = 'public.pdf_jobs'::regclass
   LIMIT 1;

  IF pk_constraint_name IS NOT NULL THEN
    -- Inspect the column count of the current PK. If it is already
    -- the composite we want, skip the drop. Otherwise drop it.
    IF (
      SELECT array_length(c.conkey, 1)
        FROM pg_constraint c
       WHERE c.conname = pk_constraint_name
         AND c.conrelid = 'public.pdf_jobs'::regclass
    ) IS DISTINCT FROM 2 THEN
      EXECUTE format('ALTER TABLE public.pdf_jobs DROP CONSTRAINT %I', pk_constraint_name);
    END IF;
  END IF;

  -- 2. Add the composite PK if it is not already there.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.contype = 'p'
       AND c.conrelid = 'public.pdf_jobs'::regclass
       AND c.conkey = ARRAY[
             (SELECT attnum FROM pg_attribute
                WHERE attrelid = 'public.pdf_jobs'::regclass AND attname = 'user_id'),
             (SELECT attnum FROM pg_attribute
                WHERE attrelid = 'public.pdf_jobs'::regclass AND attname = 'pdf_slug')
           ]::smallint[]
  ) THEN
    ALTER TABLE public.pdf_jobs
      ADD PRIMARY KEY (user_id, pdf_slug);
  END IF;

  -- 3. Touch every existing row's last_seen so the migration is
  --    observably visible in the audit log, not silently applied.
  UPDATE public.pdf_jobs
     SET last_seen = now()
   WHERE last_seen IS NOT NULL
     AND last_seen < now();
END $$;
