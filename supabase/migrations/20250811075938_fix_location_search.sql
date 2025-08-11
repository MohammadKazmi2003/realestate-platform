-- This migration safely updates the unified_listings_view and its dependent
-- search_all_properties function to fix the location search logic and add the missing columns.

-- Step 1: Drop the view and any dependent functions (like search_all_properties)
DROP VIEW IF EXISTS public.unified_listings_view CASCADE;

-- Step 2: Recreate the unified_listings_view with all required columns
CREATE OR REPLACE VIEW public.unified_listings_view AS
SELECT
    -- Projects section
    p.id,
    p.name AS title,
    p.description_html AS description,
    p.low_price AS price,
    '/project/' || p.slug AS page_link,
    'project' AS listing_type,
    (SELECT pi.storage_path_original FROM public.project_images pi WHERE pi.project_id = p.id ORDER BY pi.is_primary DESC, pi.id ASC LIMIT 1) AS image_url,
    (SELECT l.name FROM public.project_locations pl JOIN public.locations l ON pl.location_id = l.id WHERE pl.project_id = p.id ORDER BY l.level DESC LIMIT 1) AS location,
    (SELECT STRING_AGG(DISTINCT uct.property_type, ', ') FROM public.unit_configurations uct WHERE uct.project_id = p.id) AS property_type,
    -- FIX: Cast the result of MIN() to TEXT before using regexp_replace
    (SELECT CAST(NULLIF(regexp_replace(MIN(uc.bedrooms)::TEXT, '[^0-9]', '', 'g'), '') AS INT) FROM public.unit_configurations uc WHERE uc.project_id = p.id) AS bedrooms
FROM public.projects p

UNION ALL

SELECT
    -- Properties section
    prop.id,
    prop.title,
    prop.description,
    prop.price,
    '/property/' || prop.id::text AS page_link,
    'property' AS listing_type,
    (SELECT pm.media_url FROM public.property_media pm WHERE pm.property_id = prop.id ORDER BY pm.display_order ASC LIMIT 1) AS image_url,
    (SELECT l.name FROM public.property_locations pl JOIN public.locations l ON pl.location_id = l.id WHERE pl.property_id = prop.id ORDER BY l.level DESC LIMIT 1) AS location,
    pt.name AS property_type,
    -- FIX: Corrected the CAST function syntax
    (SELECT CAST(NULLIF(regexp_replace(bhk.label, '[^0-9]', '', 'g'), '') AS INT)) AS bedrooms
FROM public.properties prop
LEFT JOIN public.property_types pt ON prop.property_type_id = pt.id
LEFT JOIN public.details_residential dr ON prop.id = dr.property_id
LEFT JOIN public.bhk_types bhk ON dr.bhk_type_id = bhk.id;


-- Step 3: Recreate the search_all_properties function that was dropped by the CASCADE
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
            SELECT id FROM public.locations WHERE name ILIKE '%' || p_location || '%'
            UNION
            SELECT l.id FROM public.locations l
            INNER JOIN location_hierarchy lh ON l.parent_id = lh.id
        )
        SELECT array_agg(id) INTO v_location_ids FROM location_hierarchy;
    END IF;

    RETURN QUERY
    SELECT * FROM public.unified_listings_view ulv
    WHERE
        -- Check the correct locations table based on the listing type
        (p_location IS NULL OR
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
        AND (ulv.id <> ALL(p_exclude_ids))
    LIMIT 10;
END;
$$ LANGUAGE plpgsql;
