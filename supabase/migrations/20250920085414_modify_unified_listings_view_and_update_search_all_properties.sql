-- This migration corrects the search function by removing the explicit ordering
-- by price, which was causing the highest-priced items to always appear first.
-- It reverts to the default ordering, providing more balanced search results.

CREATE OR REPLACE FUNCTION public.search_all_properties(
p_location TEXT DEFAULT NULL,
p_property_type TEXT DEFAULT NULL,
p_min_price NUMERIC DEFAULT NULL,
p_max_price NUMERIC DEFAULT NULL,
p_bedrooms INT DEFAULT NULL,
p_amenities TEXT[] DEFAULT NULL,
p_exclude_ids UUID[] DEFAULT '{}',
p_page INT DEFAULT 1,
p_limit INT DEFAULT 10
)
RETURNS SETOF unified_listings_view AS $$
DECLARE
v_location_ids UUID[];
BEGIN
IF p_location IS NOT NULL THEN
WITH RECURSIVE location_hierarchy AS (
(SELECT id FROM public.locations WHERE name ILIKE p_location LIMIT 1)
UNION
SELECT l.id FROM public.locations l INNER JOIN location_hierarchy lh ON l.parent_id = lh.id
)
SELECT array_agg(id) INTO v_location_ids FROM location_hierarchy;
END IF;

RETURN QUERY
SELECT * FROM public.unified_listings_view ulv
WHERE
    (p_location IS NULL OR v_location_ids IS NULL OR
        (ulv.listing_type = 'property' AND EXISTS (
            SELECT 1 FROM public.property_locations pl WHERE pl.property_id = ulv.id AND pl.location_id = ANY(v_location_ids)
        )) OR
        (ulv.listing_type = 'project' AND EXISTS (
            SELECT 1 FROM public.project_locations prl WHERE prl.project_id = ulv.id AND prl.location_id = ANY(v_location_ids)
        ))
    )
    AND (p_property_type IS NULL OR ulv.property_type ILIKE '%' || p_property_type || '%')
    AND (p_min_price IS NULL OR ulv.price >= p_min_price)
    AND (p_max_price IS NULL OR ulv.price <= p_max_price)
    AND (p_bedrooms IS NULL OR ulv.bedrooms = p_bedrooms)
    AND (p_amenities IS NULL OR EXISTS (
        SELECT 1 FROM unnest(p_amenities) AS amenity
        WHERE ulv.description ILIKE '%' || amenity || '%'
    ))
    AND (array_length(p_exclude_ids, 1) IS NULL OR ulv.id <> ALL(p_exclude_ids))
-- FIX: The 'ORDER BY ulv.price DESC' clause has been removed to prevent skewed results.
LIMIT p_limit
OFFSET (p_page - 1) * p_limit;

END;
$$ LANGUAGE plpgsql;