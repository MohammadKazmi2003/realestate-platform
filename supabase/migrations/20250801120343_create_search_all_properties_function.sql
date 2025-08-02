-- This function now queries the unified_listings_view, making it much simpler
-- and allowing it to search across both projects and properties simultaneously.

CREATE OR REPLACE FUNCTION search_all_properties(
    p_location TEXT DEFAULT NULL,
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_bedrooms INT DEFAULT NULL
    -- Add other parameters as needed
)
RETURNS TABLE (
    -- Return fields for property cards
    id UUID,
    title TEXT,
    listing_type TEXT,
    image_url TEXT,
    price NUMERIC,
    location TEXT,
    bedrooms INT,
    bathrooms INT,
    area_sqft NUMERIC, -- Changed to NUMERIC to match view
    page_link TEXT
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
        v.page_link
    FROM
        public.unified_listings_view v
    WHERE
        (p_location IS NULL OR v.location ILIKE '%' || p_location || '%')
    AND (p_min_price IS NULL OR v.price >= p_min_price)
    AND (p_max_price IS NULL OR v.price <= p_max_price)
    AND (p_bedrooms IS NULL OR v.bedrooms = p_bedrooms);
    -- Add more WHERE clauses for other filters
END;
$$;
