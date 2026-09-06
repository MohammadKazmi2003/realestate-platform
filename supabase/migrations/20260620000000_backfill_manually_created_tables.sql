-- Backfill: property_locations + session_memory were created directly in the
-- database (Studio/psql) without a migration file, so `db push` failed later
-- files that reference them (20260627000001/2 need property_locations).
-- This captures their exact live definition (columns, PKs, FKs, indexes,
-- RLS, policies, grants) so history is complete and replayable.
-- Timestamp sits between 20260614000001 and 20260627000001 so it applies
-- before its dependents. Validated via scratch-DB rehearsal against a copy
-- of the remote schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Guarantee public.vector: fresh clones and db-diff shadow DBs have no
-- vector type in public (remote got his from an early manual install, which
-- is exactly the drift this file backfills). If the extension already lives
-- in another schema, relocate it instead of failing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'vector' AND n.nspname = 'public'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
      ALTER EXTENSION vector SET SCHEMA public;
    ELSE
      CREATE EXTENSION vector WITH SCHEMA public;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "public"."property_locations" (
    "property_id" "uuid" NOT NULL,
    "location_id" "uuid" NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."session_memory" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "session_id" "text" NOT NULL,
    "text_content" "text" NOT NULL,
    "embedding" "public"."vector"(768) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."property_locations"
    ADD CONSTRAINT "property_locations_pkey" PRIMARY KEY ("property_id", "location_id");

ALTER TABLE ONLY "public"."session_memory"
    ADD CONSTRAINT "session_memory_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."property_locations"
    ADD CONSTRAINT "property_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."property_locations"
    ADD CONSTRAINT "property_locations_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE CASCADE;

-- HNSW needs pgvector >= 0.5; fall back to ivfflat on older servers so the
-- push never fails on index method support.
DO $$
BEGIN
    CREATE INDEX "idx_session_memory_embedding" ON "public"."session_memory" USING "hnsw" ("embedding" "public"."vector_cosine_ops");
EXCEPTION WHEN OTHERS THEN
    CREATE INDEX IF NOT EXISTS "idx_session_memory_embedding" ON "public"."session_memory" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists" = '100');
END $$;

CREATE INDEX IF NOT EXISTS "idx_session_memory_session_id" ON "public"."session_memory" USING "btree" ("session_id");
CREATE INDEX IF NOT EXISTS "property_locations_location_id_idx" ON "public"."property_locations" USING "btree" ("location_id");
CREATE INDEX IF NOT EXISTS "property_locations_property_id_idx" ON "public"."property_locations" USING "btree" ("property_id");

ALTER TABLE "public"."property_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."session_memory" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable public read access for all users" ON "public"."property_locations" FOR SELECT USING (true);
CREATE POLICY "Block all direct access to session_memory" ON "public"."session_memory" USING (false) WITH CHECK (false);

GRANT ALL ON TABLE "public"."property_locations" TO "anon";
GRANT ALL ON TABLE "public"."property_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."property_locations" TO "service_role";
GRANT ALL ON TABLE "public"."session_memory" TO "anon";
GRANT ALL ON TABLE "public"."session_memory" TO "authenticated";
GRANT ALL ON TABLE "public"."session_memory" TO "service_role";
