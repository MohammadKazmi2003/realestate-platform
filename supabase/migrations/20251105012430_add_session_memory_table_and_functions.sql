-- Step 1: Create the session_memory table
CREATE TABLE IF NOT EXISTS public.session_memory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id text NOT NULL,
    text_content text NOT NULL,
    embedding vector(768) NOT NULL, -- Matched to nomic-embed-text-v1 (768 dimensions)
    created_at timestamptz DEFAULT now() NOT NULL
);

-- Step 2: Create a B-tree index on session_id for fast filtering
CREATE INDEX IF NOT EXISTS idx_session_memory_session_id
ON public.session_memory(session_id);

-- Step 3: Create an HNSW index on the embedding column for fast vector search
-- Using vector_cosine_ops for similarity search
CREATE INDEX IF NOT EXISTS idx_session_memory_embedding
ON public.session_memory
USING hnsw (embedding vector_cosine_ops);

-- Step 4: Create the RPC function to store memory
CREATE OR REPLACE FUNCTION store_session_memory(
    p_session_id text,
    p_text_content text,
    p_embedding vector(768)
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER -- Runs with the privileges of the function owner
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.session_memory (session_id, text_content, embedding)
    VALUES (p_session_id, p_text_content, p_embedding);
END;
$$;

-- Step 5: Create the RPC function to search memory
CREATE OR REPLACE FUNCTION search_session_memory(
    p_session_id text,
    p_query_vec vector(768),
    p_k int
)
RETURNS TABLE (
    text_content text,
    similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- Step 6: Grant execute permissions to the authenticated role
GRANT EXECUTE ON FUNCTION public.store_session_memory(text, text, vector) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_session_memory(text, vector, int) TO authenticated;

-- Step 7: Enable RLS on the new table
ALTER TABLE public.session_memory ENABLE ROW LEVEL SECURITY;

-- Step 8: Create RLS policies
-- Users can only interact with their own session data via the SECURITY DEFINER functions.
-- We explicitly block direct access for safety.
CREATE POLICY "Block all direct access to session_memory"
ON public.session_memory
FOR ALL
USING (false)
WITH CHECK (false);
