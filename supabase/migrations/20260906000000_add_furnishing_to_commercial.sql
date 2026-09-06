-- Add furnishing_status to commercial details so rent + commercial
-- listings show the same furnishing info as residential.
ALTER TABLE public.details_commercial
ADD COLUMN IF NOT EXISTS furnishing_status_id int REFERENCES public.lookup_furnishing_statuses(id);

-- Refresh get_property_details to include commercial furnishing join
DROP FUNCTION IF EXISTS public.get_property_details(uuid);
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
        'latitude', extensions.ST_Y(p.location_point::extensions.geometry),
        'longitude', extensions.ST_X(p.location_point::extensions.geometry),
        'created_at', p.created_at,
        'profiles', to_jsonb(prof),
        'property_types', to_jsonb(pt),
        'lookup_listing_purposes', to_jsonb(llp),
        'lookup_availability_statuses', to_jsonb(las),
        'lookup_ownership_types', to_jsonb(lot),
        'details_residential', COALESCE((SELECT jsonb_agg(dr_agg) FROM (SELECT dr.*, to_jsonb(bt) as bhk_types, to_jsonb(lfs) as lookup_furnishing_statuses FROM details_residential dr LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id LEFT JOIN lookup_furnishing_statuses lfs ON dr.furnishing_status_id = lfs.id WHERE dr.property_id = p.id) dr_agg), '[]'::jsonb),
        'details_commercial', COALESCE((SELECT jsonb_agg(dc_agg) FROM (SELECT dc.*, to_jsonb(lcst) as lookup_commercial_sub_types, to_jsonb(lcot) as office_type, to_jsonb(lfsc) as lookup_furnishing_statuses FROM details_commercial dc LEFT JOIN lookup_commercial_sub_types lcst ON dc.commercial_sub_type_id = lcst.id LEFT JOIN lookup_commercial_office_types lcot ON dc.office_type_id = lcot.id LEFT JOIN lookup_furnishing_statuses lfsc ON dc.furnishing_status_id = lfsc.id WHERE dc.property_id = p.id) dc_agg), '[]'::jsonb),
        'details_land', COALESCE((SELECT jsonb_agg(dl.*) FROM details_land dl WHERE dl.property_id = p.id), '[]'::jsonb),
        'property_media', (SELECT COALESCE(jsonb_agg(pm.* ORDER BY pm.display_order), '[]'::jsonb) FROM property_media pm WHERE pm.property_id = p.id),
        'lookup_amenities', (SELECT COALESCE(jsonb_agg(la.*), '[]'::jsonb) FROM junction_property_amenities jpa JOIN lookup_amenities la ON jpa.amenity_id = la.id WHERE jpa.property_id = p.id),
        'lookup_furnishing_items', (SELECT COALESCE(jsonb_agg(lfi.*), '[]'::jsonb) FROM junction_property_furnishings jpf JOIN lookup_furnishing_items lfi ON jpf.furnishing_item_id = lfi.id WHERE jpf.property_id = p.id),
        'lookup_other_rooms', (SELECT COALESCE(jsonb_agg(lor.*), '[]'::jsonb) FROM junction_property_other_rooms jpor JOIN lookup_other_rooms lor ON jpor.room_id = lor.id WHERE jpor.property_id = p.id),
        'lookup_location_advantages', (SELECT COALESCE(jsonb_agg(lla.*), '[]'::jsonb) FROM junction_property_location_advantages jpla JOIN lookup_location_advantages lla ON jpla.advantage_id = lla.id WHERE jpla.property_id = p.id),
        'lookup_land_features', (SELECT COALESCE(jsonb_agg(llf.*), '[]'::jsonb) FROM junction_property_land_features jplf JOIN lookup_land_features llf ON jplf.feature_id = llf.id WHERE jplf.property_id = p.id)
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

-- Extend search_properties fallback to include furnishing/listing_purpose/bedrooms/area_sqft parity
DROP FUNCTION IF EXISTS public.search_properties(text, numeric, numeric, int, int, int, double precision, double precision, double precision, double precision, text, timestamptz, uuid, int);
CREATE OR REPLACE FUNCTION public.search_properties(
    p_location_text text DEFAULT NULL,
    p_min_price numeric DEFAULT NULL,
    p_max_price numeric DEFAULT NULL,
    p_bhk_type_id int DEFAULT NULL,
    p_property_type_id int DEFAULT NULL,
    p_listing_purpose_id int DEFAULT NULL,
    min_lat double precision DEFAULT NULL,
    max_lat double precision DEFAULT NULL,
    min_lng double precision DEFAULT NULL,
    max_lng double precision DEFAULT NULL,
    p_search_query text DEFAULT NULL,
    p_cursor_created_at timestamptz DEFAULT NULL,
    p_cursor_id uuid DEFAULT NULL,
    p_limit int DEFAULT 24
)
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    latitude double precision,
    longitude double precision,
    area numeric,
    area_unit text,
    area_sqft numeric,
    bhk_type_label text,
    bedrooms int,
    bathrooms int,
    balconies int,
    cabins int,
    workstations int,
    furnishing_status text,
    listing_purpose text,
    owner_phone text,
    user_id uuid,
    image_url text,
    property_type_name text,
    rank real
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_ts_query tsquery;
BEGIN
    v_ts_query := CASE
        WHEN p_search_query IS NOT NULL AND p_search_query != ''
        THEN plainto_tsquery('english', p_search_query)
        ELSE NULL
    END;

    RETURN QUERY
    SELECT
        p.id, p.title, p.price, p.location_text,
        ST_Y(p.location_point::geometry) as latitude,
        ST_X(p.location_point::geometry) as longitude,
        COALESCE(dl.plot_area, dr.carpet_area, dr.built_up_area, dr.super_built_up_area, dc.carpet_area) AS area,
        COALESCE(dl.area_unit, 'sqft') AS area_unit,
        COALESCE(dl.plot_area, dr.carpet_area, dr.built_up_area, dr.super_built_up_area, dc.carpet_area) AS area_sqft,
        bt.label as bhk_type_label,
        CASE
          WHEN bt.label ILIKE 'studio%' THEN 0
          WHEN bt.label ~ '(\d+(\.\d+)?)' THEN FLOOR((regexp_match(bt.label, '(\d+(\.\d+)?)'))[1]::numeric)::int
          ELSE NULL
        END AS bedrooms,
        dr.bathrooms, dr.balconies,
        dc.cabins, COALESCE(dc.workstations, dc.max_seats),
        COALESCE(fs_r.name, fs_c.name) AS furnishing_status,
        lp.name AS listing_purpose,
        prof.phone_number AS owner_phone,
        p.user_id,
        (SELECT pm.media_url FROM property_media pm
         WHERE pm.property_id = p.id ORDER BY pm.display_order LIMIT 1) AS image_url,
        pt.name as property_type_name,
        CASE WHEN v_ts_query IS NOT NULL
             THEN ts_rank(p.search_vector, v_ts_query)
             ELSE 0 END AS rank
    FROM properties p
    LEFT JOIN property_types pt ON p.property_type_id = pt.id
    LEFT JOIN lookup_listing_purposes lp ON p.listing_purpose_id = lp.id
    LEFT JOIN profiles prof ON p.user_id = prof.id
    LEFT JOIN details_residential dr ON p.id = dr.property_id
    LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id
    LEFT JOIN lookup_furnishing_statuses fs_r ON dr.furnishing_status_id = fs_r.id
    LEFT JOIN details_commercial dc ON p.id = dc.property_id
    LEFT JOIN lookup_furnishing_statuses fs_c ON dc.furnishing_status_id = fs_c.id
    LEFT JOIN details_land dl ON p.id = dl.property_id
    WHERE
        p.status = 'available'
    AND (p_location_text IS NULL OR p.location_text ILIKE '%' || p_location_text || '%')
    AND (p_min_price IS NULL OR p.price >= p_min_price)
    AND (p_max_price IS NULL OR p.price <= p_max_price)
    AND (p_bhk_type_id IS NULL OR dr.bhk_type_id = p_bhk_type_id)
    AND (p_property_type_id IS NULL OR p.property_type_id = p_property_type_id)
    AND (p_listing_purpose_id IS NULL OR p.listing_purpose_id = p_listing_purpose_id)
    AND (v_ts_query IS NULL OR p.search_vector @@ v_ts_query)
    AND (
        min_lat IS NULL OR
        (p.location_point IS NOT NULL AND p.location_point && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)::geography)
    )
    AND (
        p_cursor_created_at IS NULL
        OR (p.created_at, p.id) < (p_cursor_created_at, p_cursor_id)
    )
    ORDER BY
        CASE WHEN v_ts_query IS NOT NULL THEN ts_rank(p.search_vector, v_ts_query) ELSE 0 END DESC,
        p.created_at DESC,
        p.id DESC
    LIMIT p_limit;
END;
$$;
