-- Parity cleanup after the 2026-09-06 remote push (found by post-push diff).
--
-- 1. Stale overloads shadowed by their replacements. The surviving 9-arg
--    search_properties made the ES-down PG fallback ambiguous
--    ("function search_properties(...) is not unique" — proven); the 6-arg
--    search_all_properties has no callers anywhere in src/ or api_py/.
DROP FUNCTION IF EXISTS public.search_properties(text, numeric, numeric, integer, integer, double precision, double precision, double precision, double precision);
DROP FUNCTION IF EXISTS public.search_all_properties(text, text, numeric, numeric, integer, text[]);

-- 2. session_memory helpers were created by hand locally (no migration);
--    capture their exact live definitions so remote matches.
CREATE OR REPLACE FUNCTION "public"."search_session_memory"("p_session_id" "text", "p_query_vec" "public"."vector", "p_k" integer) RETURNS TABLE("text_content" "text", "similarity" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        sm.text_content,
        1 - (sm.embedding <=> p_query_vec) AS similarity -- Cosine similarity
    FROM
        public.session_memory sm
    WHERE
        sm.session_id = p_session_id
    ORDER BY
        sm.embedding <=> p_query_vec -- Order by cosine distance (ASC)
    LIMIT
        p_k;
END;
$$;

ALTER FUNCTION "public"."search_session_memory"("p_session_id" "text", "p_query_vec" "public"."vector", "p_k" integer) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."store_session_memory"("p_session_id" "text", "p_text_content" "text", "p_embedding" "public"."vector") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    INSERT INTO public.session_memory (session_id, text_content, embedding)
    VALUES (p_session_id, p_text_content, p_embedding);
END;
$$;

ALTER FUNCTION "public"."store_session_memory"("p_session_id" "text", "p_text_content" "text", "p_embedding" "public"."vector") OWNER TO "postgres";

-- 3. profiles_id_fkey exists only on remote (predates tracked history).
--    Mirror it under version control so future diffs are clean. Guarded:
--    remote already has it, local gains it.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_fkey') THEN
        ALTER TABLE ONLY public.profiles
            ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;
END $$;
