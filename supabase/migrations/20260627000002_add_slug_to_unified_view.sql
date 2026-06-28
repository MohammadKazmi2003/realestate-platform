-- Add slug column to unified_listings_view so project results
-- can link to /projects/[slug] from chatbot search results.

DROP VIEW IF EXISTS public.unified_listings_view CASCADE;

CREATE VIEW public.unified_listings_view AS
SELECT
    p.id,
    p.slug,
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

SELECT
    prop.id,
    NULL::text AS slug,
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
    NULL::vector(768) AS description_embedding
FROM
    public.properties prop
LEFT JOIN
    public.property_types pt ON prop.property_type_id = pt.id
LEFT JOIN
    public.details_residential dr ON prop.id = dr.property_id
LEFT JOIN
    public.bhk_types bhk ON dr.bhk_type_id = bhk.id;

-- Re-create dependent functions that were dropped by CASCADE.

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

DROP FUNCTION IF EXISTS public.text_search_properties(text, uuid[]);

CREATE FUNCTION public.text_search_properties(
    p_query text,
    p_exclude_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS TABLE(id uuid, slug text, title text, description text, price numeric, page_link text, listing_type text, image_url text, location text, property_type text, bedrooms integer)
LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        v.id,
        v.slug,
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
RETURNS TABLE(id uuid, slug text, title text, listing_type text, image_url text, price numeric, location text, bedrooms integer, page_link text, similarity double precision)
LANGUAGE plpgsql
AS $function$
BEGIN
    RETURN QUERY
    SELECT
        v.id,
        v.slug,
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
