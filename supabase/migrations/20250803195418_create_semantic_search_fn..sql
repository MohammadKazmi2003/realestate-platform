-- Creates a function to perform semantic search on the unified listings view.
-- It takes a query embedding and returns listings that are semantically similar.

CREATE OR REPLACE FUNCTION match_properties_semantic(
    query_embedding vector(1536),
    match_threshold float,
    match_count int
)
RETURNS TABLE (
    -- These columns must match the unified_listings_view structure
    id UUID,
    title TEXT,
    listing_type TEXT,
    image_url TEXT,
    price NUMERIC,
    location TEXT,
    bedrooms INT,
    bathrooms INT,
    area_sqft NUMERIC,
    page_link TEXT,
    similarity float -- Add similarity score to the output
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        v.id,
        v.title,
        v.listing_type,
        v.image_url,
        v.price,
        v.location,
        v.bedrooms,
        v.bathrooms,
        v.area_sqft,
        v.page_link,
        -- Cosine similarity is calculated as 1 - cosine distance
        1 - (v.description_embedding <=> query_embedding) AS similarity
    FROM
        public.unified_listings_view v
    -- Ensure we only match listings that have an embedding
    WHERE v.description_embedding IS NOT NULL
      AND 1 - (v.description_embedding <=> query_embedding) > match_threshold
    ORDER BY
        similarity DESC
    LIMIT
        match_count;
END;
$$;
