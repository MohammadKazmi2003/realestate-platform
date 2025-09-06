-- New migration to add a full-text search function for property names and descriptions.
-- This enables more natural language searching for specific properties.

CREATE OR REPLACE FUNCTION text_search_properties(
    p_query text,
    p_exclude_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS TABLE (
    id uuid,
    title text,
    description text,
    price numeric,
    page_link text,
    listing_type text,
    image_url text,
    location text,
    property_type text,
    bedrooms integer
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        v.id,
        v.title,
        v.description,
        v.price,
        v.page_link,
        v.listing_type,
        v.image_url,
        v.location,
        v.property_type,
        v.bedrooms
    FROM
        unified_listings_view v
    WHERE
        -- Use to_tsvector and to_tsquery for efficient full-text search
        to_tsvector('english', v.title || ' ' || v.description) @@ to_tsquery('english', p_query)
        AND v.id <> ALL(p_exclude_ids)
    LIMIT 10;
END;
$$ LANGUAGE plpgsql;

