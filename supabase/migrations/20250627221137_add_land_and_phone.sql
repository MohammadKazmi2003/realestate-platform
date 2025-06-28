-- supabase/migrations/YYYYMMDDHHMMSS_add_land_and_phone.sql

-- 1. Add phone_number to the profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_number TEXT;

-- 2. Create the new details_land table
CREATE TABLE IF NOT EXISTS public.details_land (
    property_id uuid PRIMARY KEY REFERENCES public.properties(id) ON DELETE CASCADE,
    plot_area numeric,
    area_unit TEXT,
    is_boundary_wall_made BOOLEAN
);

-- 3. Safely update the get_property_details function
-- DROP the existing function to avoid "cannot change return type" errors
DROP FUNCTION IF EXISTS public.get_property_details(uuid);

-- CREATE the updated function
CREATE OR REPLACE FUNCTION public.get_property_details(p_property_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
SELECT
    jsonb_build_object(
        'id', p.id,
        'user_id', p.user_id,
        'title', p.title,
        'description', p.description,
        'price', p.price,
        'is_price_negotiable', p.is_price_negotiable,
        'location_text', p.location_text,
        'created_at', p.created_at,
        'profiles', to_jsonb(prof),
        'property_types', to_jsonb(pt),
        'lookup_listing_purposes', to_jsonb(llp),
        'lookup_availability_statuses', to_jsonb(las),
        'lookup_ownership_types', to_jsonb(lot),
        'details_residential', COALESCE((SELECT jsonb_agg(dr_agg) FROM (SELECT dr.*, to_jsonb(bt) as bhk_types, to_jsonb(lfs) as lookup_furnishing_statuses FROM details_residential dr LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id LEFT JOIN lookup_furnishing_statuses lfs ON dr.furnishing_status_id = lfs.id WHERE dr.property_id = p.id) dr_agg), '[]'::jsonb),
        'details_commercial', COALESCE((SELECT jsonb_agg(dc_agg) FROM (SELECT dc.*, to_jsonb(lcst) as lookup_commercial_sub_types FROM details_commercial dc LEFT JOIN lookup_commercial_sub_types lcst ON dc.commercial_sub_type_id = lcst.id WHERE dc.property_id = p.id) dc_agg), '[]'::jsonb),
        'details_land', COALESCE((SELECT jsonb_agg(dl.*) FROM details_land dl WHERE dl.property_id = p.id), '[]'::jsonb),
        'property_media', (SELECT COALESCE(jsonb_agg(pm.* ORDER BY pm.display_order), '[]'::jsonb) FROM property_media pm WHERE pm.property_id = p.id),
        'lookup_amenities', (SELECT COALESCE(jsonb_agg(la.*), '[]'::jsonb) FROM junction_property_amenities jpa JOIN lookup_amenities la ON jpa.amenity_id = la.id WHERE jpa.property_id = p.id),
        'lookup_furnishing_items', (SELECT COALESCE(jsonb_agg(lfi.*), '[]'::jsonb) FROM junction_property_furnishings jpf JOIN lookup_furnishing_items lfi ON jpf.furnishing_item_id = lfi.id WHERE jpf.property_id = p.id),
        'lookup_other_rooms', (SELECT COALESCE(jsonb_agg(lor.*), '[]'::jsonb) FROM junction_property_other_rooms jpor JOIN lookup_other_rooms lor ON jpor.room_id = lor.id WHERE jpor.property_id = p.id),
        'lookup_location_advantages', (SELECT COALESCE(jsonb_agg(lla.*), '[]'::jsonb) FROM junction_property_location_advantages jpla JOIN lookup_location_advantages lla ON jpla.advantage_id = lla.id WHERE jpla.property_id = p.id)
    )
FROM
    properties p
LEFT JOIN profiles prof ON p.user_id = prof.id
LEFT JOIN property_types pt ON p.property_type_id = pt.id
LEFT JOIN lookup_listing_purposes llp ON p.listing_purpose_id = llp.id
LEFT JOIN lookup_availability_statuses las ON p.availability_status_id = las.id
LEFT JOIN lookup_ownership_types lot ON p.ownership_type_id = lot.id
WHERE
    p.id = p_property_id
GROUP BY
    p.id, prof.id, pt.id, llp.id, las.id, lot.id;
$$;

-- 4. Safely update the get_all_listings_paginated function
DROP FUNCTION IF EXISTS public.get_all_listings_paginated(text, int, int, text, int, int);

CREATE OR REPLACE FUNCTION get_all_listings_paginated(
    p_location_text text,
    p_bhk_type_id int,
    p_property_type_id int,
    p_sort_by text,
    p_page_num int,
    p_items_per_page int
)
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    area_sqft numeric,
    plot_area numeric,
    area_unit text,
    owner_phone text,
    user_id uuid,
    images jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_offset int;
BEGIN
    v_offset := (p_page_num - 1) * p_items_per_page;

    RETURN QUERY
    SELECT
        p.id,
        p.title,
        p.price,
        p.location_text,
        COALESCE(dr.carpet_area, dc.carpet_area) AS area_sqft,
        dl.plot_area,
        dl.area_unit,
        prof.phone_number as owner_phone,
        p.user_id,
        (
            SELECT COALESCE(jsonb_agg(jsonb_build_object('image_url', pm.media_url)), '[]'::jsonb)
            FROM property_media pm
            WHERE pm.property_id = p.id
        ) AS images
    FROM
        properties p
    LEFT JOIN profiles prof ON p.user_id = prof.id
    LEFT JOIN details_residential dr ON p.id = dr.property_id
    LEFT JOIN details_commercial dc ON p.id = dc.property_id
    LEFT JOIN details_land dl ON p.id = dl.property_id
    WHERE
        (p_location_text IS NULL OR p.location_text ILIKE '%' || p_location_text || '%')
    AND (p_bhk_type_id IS NULL OR dr.bhk_type_id = p_bhk_type_id)
    AND (p_property_type_id IS NULL OR p.property_type_id = p_property_type_id)
    ORDER BY
        CASE WHEN p_sort_by = 'created_at' THEN p.created_at END DESC,
        CASE WHEN p_sort_by = 'price_asc' THEN p.price END ASC,
        CASE WHEN p_sort_by = 'price_desc' THEN p.price END DESC
    LIMIT p_items_per_page
    OFFSET v_offset;
END;
$$;