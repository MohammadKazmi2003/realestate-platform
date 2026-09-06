-- ============================================================
-- Phase 1a: Update unified_listings_view to include all
-- project fields needed for rich search results and semantic
-- matching.
-- ============================================================

DROP VIEW IF EXISTS public.unified_listings_view CASCADE;

CREATE VIEW public.unified_listings_view AS
-- Project branch: enriched with all relevant project fields
SELECT
    p.id,
    p.name AS title,
    p.description_html AS description,
    p.low_price AS price,
    p.high_price,
    p.construction_phase,
    p.delivery_date,
    d.name AS developer_name,
    '/project/'::text || p.slug AS page_link,
    'project'::text AS listing_type,
    (
        SELECT pi.storage_path_original
        FROM public.project_images pi
        WHERE pi.project_id = p.id
        ORDER BY pi.is_primary DESC, pi.id
        LIMIT 1
    ) AS image_url,
    (
        SELECT l.name
        FROM public.project_locations pl
        JOIN public.locations l ON pl.location_id = l.id
        WHERE pl.project_id = p.id
        ORDER BY l.level DESC
        LIMIT 1
    ) AS location,
    (
        SELECT string_agg(DISTINCT uct.property_type, ', '::text)
        FROM public.unit_configurations uct
        WHERE uct.project_id = p.id
    ) AS property_type,
    (
        SELECT NULLIF(regexp_replace(min(uc.bedrooms)::text, '[^0-9]'::text, ''::text, 'g'::text), ''::text)::integer
        FROM public.unit_configurations uc
        WHERE uc.project_id = p.id
    ) AS bedrooms,
    p.description_embedding
FROM
    public.projects p
LEFT JOIN
    public.developers d ON p.developer_id = d.id

UNION ALL

-- Property branch: unchanged
SELECT
    prop.id,
    prop.title,
    prop.description,
    prop.price,
    NULL::numeric AS high_price,
    NULL::text AS construction_phase,
    NULL::timestamptz AS delivery_date,
    NULL::text AS developer_name,
    '/property/'::text || prop.id::text AS page_link,
    'property'::text AS listing_type,
    (
        SELECT pm.media_url
        FROM public.property_media pm
        WHERE pm.property_id = prop.id
        ORDER BY pm.display_order
        LIMIT 1
    ) AS image_url,
    (
        SELECT l.name
        FROM public.property_locations pl
        JOIN public.locations l ON pl.location_id = l.id
        WHERE pl.property_id = prop.id
        ORDER BY l.level DESC
        LIMIT 1
    ) AS location,
    pt.name AS property_type,
    (
        SELECT NULLIF(regexp_replace(bhk.label, '[^0-9]'::text, ''::text, 'g'::text), ''::text)::integer
    ) AS bedrooms,
    NULL::public.vector(768) AS description_embedding
FROM
    public.properties prop
LEFT JOIN
    public.property_types pt ON prop.property_type_id = pt.id
LEFT JOIN
    public.details_residential dr ON prop.id = dr.property_id
LEFT JOIN
    public.bhk_types bhk ON dr.bhk_type_id = bhk.id;

-- ============================================================
-- Phase 1b: Update get_listing_details to return richer
-- project data including videos, unit_configurations,
-- master_plan_storage_path, brochure_storage_path, lat/lng.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_listing_details(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
    listing_details JSONB;
    listing_type_from_view TEXT;
BEGIN
    SELECT listing_type INTO listing_type_from_view FROM unified_listings_view WHERE id = p_listing_id;

    IF listing_type_from_view = 'property' THEN
        SELECT
            jsonb_build_object(
                'id', p.id,
                'type', 'property',
                'user_id', p.user_id,
                'title', p.title,
                'description', p.description,
                'price', p.price,
                'is_price_negotiable', p.is_price_negotiable,
                'location_text', p.location_text,
                'latitude', ST_Y(p.location_point::geometry),
                'longitude', ST_X(p.location_point::geometry),
                'created_at', p.created_at,
                'profiles', to_jsonb(prof),
                'property_types', to_jsonb(pt),
                'lookup_listing_purposes', to_jsonb(llp),
                'lookup_availability_statuses', to_jsonb(las),
                'lookup_ownership_types', to_jsonb(lot),
                'details_residential', COALESCE((SELECT jsonb_agg(dr_agg) FROM (SELECT dr.*, to_jsonb(bt) as bhk_types, to_jsonb(lfs) as lookup_furnishing_statuses FROM details_residential dr LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id LEFT JOIN lookup_furnishing_statuses lfs ON dr.furnishing_status_id = lfs.id WHERE dr.property_id = p.id) dr_agg), '[]'::jsonb),
                'details_commercial', COALESCE((SELECT jsonb_agg(dc_agg) FROM (SELECT dc.*, to_jsonb(lcst) as lookup_commercial_sub_types, to_jsonb(lcot) as office_type FROM details_commercial dc LEFT JOIN lookup_commercial_sub_types lcst ON dc.commercial_sub_type_id = lcst.id LEFT JOIN lookup_commercial_office_types lcot ON dc.office_type_id = lcot.id WHERE dc.property_id = p.id) dc_agg), '[]'::jsonb),
                'details_land', COALESCE((SELECT jsonb_agg(dl.*) FROM details_land dl WHERE dl.property_id = p.id), '[]'::jsonb),
                'property_media', (SELECT COALESCE(jsonb_agg(pm.* ORDER BY pm.display_order), '[]'::jsonb) FROM property_media pm WHERE pm.property_id = p.id),
                'lookup_amenities', (SELECT COALESCE(jsonb_agg(la.*), '[]'::jsonb) FROM junction_property_amenities jpa JOIN lookup_amenities la ON jpa.amenity_id = la.id WHERE jpa.property_id = p.id),
                'lookup_furnishing_items', (SELECT COALESCE(jsonb_agg(lfi.*), '[]'::jsonb) FROM junction_property_furnishings jpf JOIN lookup_furnishing_items lfi ON jpf.furnishing_item_id = lfi.id WHERE jpf.property_id = p.id),
                'lookup_other_rooms', (SELECT COALESCE(jsonb_agg(lor.*), '[]'::jsonb) FROM junction_property_other_rooms jpor JOIN lookup_other_rooms lor ON jpor.room_id = lor.id WHERE jpor.property_id = p.id),
                'lookup_location_advantages', (SELECT COALESCE(jsonb_agg(lla.*), '[]'::jsonb) FROM junction_property_location_advantages jpla JOIN lookup_location_advantages lla ON jpla.advantage_id = lla.id WHERE jpla.property_id = p.id),
                'lookup_land_features', (SELECT COALESCE(jsonb_agg(llf.*), '[]'::jsonb) FROM junction_property_land_features jplf JOIN lookup_land_features llf ON jplf.feature_id = llf.id WHERE jplf.property_id = p.id)
            )
        INTO listing_details
        FROM
            properties p
        LEFT JOIN profiles prof ON p.user_id = prof.id
        LEFT JOIN property_types pt ON p.property_type_id = pt.id
        LEFT JOIN lookup_listing_purposes llp ON p.listing_purpose_id = llp.id
        LEFT JOIN lookup_availability_statuses las ON p.availability_status_id = las.id
        LEFT JOIN lookup_ownership_types lot ON p.ownership_type_id = lot.id
        WHERE p.id = p_listing_id
        GROUP BY p.id, prof.id, pt.id, llp.id, las.id, lot.id;

    ELSIF listing_type_from_view = 'project' THEN
        SELECT
            jsonb_build_object(
                'id', proj.id,
                'type', 'project',
                'title', proj.name,
                'description', proj.description,
                'description_html', proj.description_html,
                'master_plan_description', proj.master_plan_description,
                'master_plan_storage_path', proj.master_plan_storage_path,
                'brochure_storage_path', proj.brochure_storage_path,
                'price_range', jsonb_build_object(
                    'low', proj.low_price,
                    'high', proj.high_price,
                    'currency', proj.price_currency
                ),
                'location_text', loc.name,
                'latitude', proj.latitude,
                'longitude', proj.longitude,
                'developer', to_jsonb(dev),
                'status', jsonb_build_object(
                    'phase', proj.construction_phase,
                    'progress_percent', proj.construction_progress_percent,
                    'delivery_date', proj.delivery_date
                ),
                'property_types', (SELECT COALESCE(jsonb_agg(DISTINCT pt.name), '[]'::jsonb) FROM unit_configurations uc JOIN property_types pt ON uc.property_type = pt.name WHERE uc.project_id = proj.id),
                'project_media', (SELECT COALESCE(jsonb_agg(pm ORDER BY pm.is_primary DESC, pm.id), '[]'::jsonb) FROM project_images pm WHERE pm.project_id = proj.id),
                'project_videos', (SELECT COALESCE(jsonb_agg(pv.*), '[]'::jsonb) FROM project_videos pv WHERE pv.project_id = proj.id),
                'unit_configurations', (SELECT COALESCE(jsonb_agg(uc.*), '[]'::jsonb) FROM unit_configurations uc WHERE uc.project_id = proj.id),
                'amenities', (SELECT COALESCE(jsonb_agg(a.*), '[]'::jsonb) FROM project_amenities pa JOIN amenities a ON pa.amenity_id = a.id WHERE pa.project_id = proj.id),
                'faqs', (SELECT COALESCE(jsonb_agg(f.*), '[]'::jsonb) FROM faqs f WHERE f.project_id = proj.id)
            )
        INTO listing_details
        FROM
            projects proj
        LEFT JOIN developers dev ON proj.developer_id = dev.id
        LEFT JOIN project_locations pl ON proj.id = pl.project_id
        LEFT JOIN locations loc ON pl.location_id = loc.id
        WHERE proj.id = p_listing_id;
    END IF;

    RETURN listing_details;
END;
$function$;

-- ============================================================
-- Phase 1c: Re-create dependent functions that were dropped by
-- CASCADE. These query unified_listings_view and must be
-- restored after the view is re-created.
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_all_properties(
    p_location text DEFAULT NULL::text,
    p_property_type text DEFAULT NULL::text,
    p_min_price numeric DEFAULT NULL::numeric,
    p_max_price numeric DEFAULT NULL::numeric,
    p_bedrooms integer DEFAULT NULL::integer,
    p_amenities text[] DEFAULT NULL::text[],
    p_exclude_ids uuid[] DEFAULT '{}'::uuid[],
    p_page integer DEFAULT 1,
    p_limit integer DEFAULT 10
)
RETURNS SETOF unified_listings_view
LANGUAGE plpgsql
AS $function$
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
LIMIT p_limit
OFFSET (p_page - 1) * p_limit;

END;
$function$;

CREATE OR REPLACE FUNCTION public.text_search_properties(
    p_query text,
    p_exclude_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS TABLE(id uuid, title text, description text, price numeric, page_link text, listing_type text, image_url text, location text, property_type text, bedrooms integer)
LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        v.id,
        v.title,
        v.description,
        v.price,
        v.page_link,
        v.listing_type,
        v.image_url,
        v.location,
        v.property_type,
        v.bedrooms
    FROM
        unified_listings_view v
    WHERE
        to_tsvector('english', v.title || ' ' || v.description) @@ websearch_to_tsquery('english', p_query)
        AND v.id <> ALL(p_exclude_ids)
    LIMIT 10;
END;
$function$;

DROP FUNCTION IF EXISTS public.match_properties_semantic(vector, double precision, integer);

CREATE FUNCTION public.match_properties_semantic(
    query_embedding vector,
    match_threshold double precision,
    match_count integer
)
RETURNS TABLE(id uuid, title text, listing_type text, image_url text, price numeric, location text, bedrooms integer, page_link text, similarity double precision)
LANGUAGE plpgsql
AS $function$
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
        v.page_link,
        1 - (v.description_embedding <=> query_embedding) AS similarity
    FROM
        public.unified_listings_view v
    WHERE v.description_embedding IS NOT NULL
      AND 1 - (v.description_embedding <=> query_embedding) > match_threshold
    ORDER BY similarity DESC
    LIMIT match_count;
END;
$function$;
