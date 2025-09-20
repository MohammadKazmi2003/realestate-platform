-- This migration updates the search_all_properties function to support hybrid pagination.
-- It adds p_page and p_limit for offset-based pagination while retaining p_exclude_ids.

DROP FUNCTION IF EXISTS public.search_all_properties(text, text, numeric, numeric, integer, text[], uuid[]);

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
-- If a location is provided, find it and all its descendants
IF p_location IS NOT NULL THEN
WITH RECURSIVE location_hierarchy AS (
(
SELECT id, 1 AS priority
FROM public.locations
WHERE name ILIKE p_location
LIMIT 1
)
UNION
(
SELECT id, 2 AS priority
FROM public.locations
WHERE name ILIKE p_location || '%'
AND NOT EXISTS (SELECT 1 FROM public.locations WHERE name ILIKE p_location)
LIMIT 1
)
UNION
SELECT l.id, lh.priority
FROM public.locations l
INNER JOIN location_hierarchy lh ON l.parent_id = lh.id
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
ORDER BY ulv.created_at DESC
LIMIT p_limit
OFFSET (p_page - 1) * p_limit;

END;
$$ LANGUAGE plpgsql;