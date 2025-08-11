-- This migration fixes the search_all_properties function by correcting the
-- column name from 'parent_location_id' to the correct 'parent_id'.

CREATE OR REPLACE FUNCTION public.search_all_properties(
    p_location TEXT DEFAULT NULL,
    p_property_type TEXT DEFAULT NULL,
    p_min_price NUMERIC DEFAULT NULL,
    p_max_price NUMERIC DEFAULT NULL,
    p_bedrooms INT DEFAULT NULL,
    p_amenities TEXT[] DEFAULT NULL,
    p_exclude_ids UUID[] DEFAULT '{}'
)
RETURNS SETOF unified_listings_view AS $$
DECLARE
    v_location_ids UUID[];
BEGIN
    -- If a location is provided, find it and all its descendants
    IF p_location IS NOT NULL THEN
        WITH RECURSIVE location_hierarchy AS (
            -- Start with the parent location(s) that match the search term
            SELECT id FROM public.locations WHERE name ILIKE '%' || p_location || '%'
            UNION
            -- Recursively find all child locations
            SELECT l.id FROM public.locations l
            -- FIX: Changed 'l.parent_location_id' to the correct column name 'l.parent_id'
            INNER JOIN location_hierarchy lh ON l.parent_id = lh.id
        )
        SELECT array_agg(id) INTO v_location_ids FROM location_hierarchy;
    END IF;

    RETURN QUERY
    SELECT * FROM public.unified_listings_view ulv
    WHERE
        -- If no location was specified, skip this check.
        -- Otherwise, check if the property is linked to any of the found location IDs.
        (p_location IS NULL OR EXISTS (
            SELECT 1 FROM public.property_locations pl WHERE pl.property_id = ulv.id AND pl.location_id = ANY(v_location_ids)
            UNION
            SELECT 1 FROM public.project_locations prl WHERE prl.project_id = ulv.id AND prl.location_id = ANY(v_location_ids)
        ))
        AND (p_property_type IS NULL OR ulv.property_type ILIKE '%' || p_property_type || '%')
        AND (p_min_price IS NULL OR ulv.price >= p_min_price)
        AND (p_max_price IS NULL OR ulv.price <= p_max_price)
        AND (p_bedrooms IS NULL OR ulv.bedrooms = p_bedrooms)
        AND (p_amenities IS NULL OR EXISTS (
            SELECT 1 FROM unnest(p_amenities) AS amenity
            WHERE ulv.description ILIKE '%' || amenity || '%'
        ))
        AND (ulv.id <> ALL(p_exclude_ids))
    LIMIT 10;
END;
$$ LANGUAGE plpgsql;
