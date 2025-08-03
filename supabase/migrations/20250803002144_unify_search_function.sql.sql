-- Drop the old, ambiguous functions first to avoid conflicts.
-- Note: The exact signature might vary. Add any other versions you have.
DROP FUNCTION IF EXISTS public.search_all_properties(p_location text, p_min_price numeric, p_max_price numeric, p_bedrooms integer);
DROP FUNCTION IF EXISTS public.search_all_properties(p_location text, p_min_price numeric, p_max_price numeric, p_bedrooms integer, p_property_type text, p_amenities text[]);

-- Create a single, unified search function that handles all parameters.
CREATE OR REPLACE FUNCTION search_all_properties(
    p_location TEXT DEFAULT NULL,
    p_property_type TEXT DEFAULT NULL,
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_bedrooms INT DEFAULT NULL,
    p_amenities TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    title TEXT,
    listing_type TEXT,
    image_url TEXT,
    price NUMERIC,
    location TEXT,
    bedrooms INT,
    bathrooms INT,
    area_sqft NUMERIC,
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
    AND (p_bedrooms IS NULL OR v.bedrooms = p_bedrooms)
    AND (p_property_type IS NULL OR v.property_type ILIKE '%' || p_property_type || '%')
    -- A simple text search for amenities in the description.
    -- For better performance, this could be implemented with a dedicated search index.
    AND (p_amenities IS NULL OR v.description ILIKE ALL (SELECT '%' || amenity || '%' FROM unnest(p_amenities) AS amenity));
END;
$$;
