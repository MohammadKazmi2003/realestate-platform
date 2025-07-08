-- This migration updates the get_properties_with_all_images function,
-- which is used by the homepage, to correctly return a unified area and
-- area_unit for all property types, including land.

-- First, DROP the old function to avoid conflicts.
DROP FUNCTION IF EXISTS public.get_properties_with_all_images();

-- Then, CREATE the new, corrected version.
CREATE OR REPLACE FUNCTION public.get_properties_with_all_images()
-- The return table is updated to use 'area' and 'area_unit'
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    area numeric,       -- UNIFIED area column
    area_unit text,     -- UNIFIED area_unit column
    owner_phone text,
    user_id uuid,
    images jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.title,
        p.price,
        p.location_text,
        -- FIXED: Prioritize plot_area for land, then fall back to residential/commercial carpet_area.
        COALESCE(dl.plot_area, dr.carpet_area, dc.carpet_area) AS area,
        -- FIXED: Prioritize the land's area_unit, otherwise default to 'sqft'.
        COALESCE(dl.area_unit, 'sqft') AS area_unit,
        prof.phone_number AS owner_phone,
        p.user_id,
        (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('image_url', pm.media_url)), '[]'::jsonb)
            FROM property_media pm
            WHERE pm.property_id = p.id
        ) AS images
    FROM
        properties p
    LEFT JOIN
        profiles prof ON p.user_id = prof.id
    LEFT JOIN
        details_residential dr ON p.id = dr.property_id
    LEFT JOIN
        details_commercial dc ON p.id = dc.property_id
    LEFT JOIN
        details_land dl ON p.id = dl.property_id -- ADDED: Join for land details
    ORDER BY
        p.created_at DESC
    LIMIT 12;
END;
$$;
