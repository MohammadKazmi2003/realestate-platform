-- This migration updates the main search function to support pagination.
-- It adds a new parameter, `p_exclude_ids`, which is an array of UUIDs.
-- The function will now filter out any properties whose IDs are in this array,
-- allowing the AI to fetch the "next page" of results.

CREATE OR REPLACE FUNCTION public.search_all_properties(
    p_location TEXT DEFAULT NULL,
    p_property_type TEXT DEFAULT NULL,
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_bedrooms INT DEFAULT NULL,
    p_amenities TEXT[] DEFAULT NULL,
    p_exclude_ids UUID[] DEFAULT '{}' -- New parameter with a default empty array
)
RETURNS SETOF unified_listings_view AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.unified_listings_view ulv
    WHERE
        (p_location IS NULL OR ulv.location ILIKE '%' || p_location || '%')
    AND
        (p_property_type IS NULL OR ulv.property_type ILIKE '%' || p_property_type || '%')
    AND
        (p_min_price IS NULL OR ulv.price >= p_min_price)
    AND
        (p_max_price IS NULL OR ulv.price <= p_max_price)
    AND
        (p_bedrooms IS NULL OR ulv.bedrooms = p_bedrooms)
    AND
        (p_amenities IS NULL OR EXISTS (
            SELECT 1
            FROM unnest(p_amenities) AS amenity
            WHERE ulv.description ILIKE '%' || amenity || '%'
        ))
    AND
        -- This is the new condition to exclude already-seen properties
        (ulv.id <> ALL(p_exclude_ids))
    LIMIT 10; -- Return a consistent number of results
END;
$$ LANGUAGE plpgsql;

 