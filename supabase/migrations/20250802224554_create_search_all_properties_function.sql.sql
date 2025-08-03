-- This function now queries the unified_listings_view and includes a filter for property_type.

CREATE OR REPLACE FUNCTION search_all_properties(
    p_location TEXT DEFAULT NULL,
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_bedrooms INT DEFAULT NULL,
    p_property_type TEXT DEFAULT NULL, -- New parameter
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
    AND (p_property_type IS NULL OR v.property_type ILIKE '%' || p_property_type || '%'); -- New filter condition
    -- Amenity filtering would require a more complex join or text search, omitted for now
END;
$$;