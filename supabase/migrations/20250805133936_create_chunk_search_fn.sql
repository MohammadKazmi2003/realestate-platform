CREATE OR REPLACE FUNCTION match_property_chunks(
    query_embedding vector(768),
    match_threshold float,
    match_count int
)
RETURNS TABLE (
    id UUID, -- Returns the ID of the parent property/project
    similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(pc.property_id, pc.project_id) as id,
        1 - (pc.embedding <=> query_embedding) as similarity
    FROM
        public.property_chunks pc
    WHERE 1 - (pc.embedding <=> query_embedding) > match_threshold
    ORDER BY similarity DESC
    LIMIT match_count;
END;
$$;