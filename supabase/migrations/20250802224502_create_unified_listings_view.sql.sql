-- This VIEW creates a virtual table that combines data from both the 'projects'
-- and 'properties' tables into a single, searchable format for the AI assistant.

CREATE OR REPLACE VIEW public.unified_listings_view AS
SELECT
    -- Common Fields
    p.id,
    p.name AS title,
    p.description_html AS description,
    p.low_price AS price,
    p.slug AS page_link,
    'project' AS listing_type, -- Differentiator
    
    -- Image
    (
        SELECT pi.storage_path_original
        FROM public.project_images pi
        WHERE pi.project_id = p.id
        ORDER BY pi.is_primary DESC, pi.id ASC
        LIMIT 1
    ) AS image_url,
    
    -- Location
    (
        SELECT l.name
        FROM public.project_locations pl
        JOIN public.locations l ON pl.location_id = l.id
        WHERE pl.project_id = p.id
        ORDER BY l.level DESC
        LIMIT 1
    ) AS location,

    -- Details
    (SELECT MIN(uc.bedrooms) FROM public.unit_configurations uc WHERE uc.project_id = p.id) AS bedrooms,
    NULL::INT AS bathrooms,
    (SELECT MIN(uc.area_from_sqft) FROM public.unit_configurations uc WHERE uc.project_id = p.id) AS area_sqft,
    -- Add property type for projects from unit configurations
    (SELECT STRING_AGG(DISTINCT uct.property_type, ', ') FROM public.unit_configurations uct WHERE uct.project_id = p.id) AS property_type

FROM
    public.projects p

UNION ALL

SELECT
    -- Common Fields
    prop.id,
    prop.title,
    prop.description,
    prop.price,
    '/property/' || prop.id::text AS page_link, -- Construct the link
    'property' AS listing_type, -- Differentiator

    -- Image
    (
        SELECT pm.media_url
        FROM public.property_media pm
        WHERE pm.property_id = prop.id
        ORDER BY pm.display_order ASC
        LIMIT 1
    ) AS image_url,

    -- Location
    prop.location_text AS location,

    -- Details
    (SELECT bhk.label::INT FROM bhk_types bhk WHERE bhk.id = dr.bhk_type_id) AS bedrooms,
    dr.bathrooms,
    COALESCE(dr.carpet_area, dc.carpet_area, dl.plot_area) AS area_sqft,
    pt.name AS property_type -- Add property type for individual listings

FROM
    public.properties prop
LEFT JOIN public.property_types pt ON prop.property_type_id = pt.id
LEFT JOIN public.details_residential dr ON prop.id = dr.property_id
LEFT JOIN public.details_commercial dc ON prop.id = dc.property_id
LEFT JOIN public.details_land dl ON prop.id = dl.property_id
WHERE
    prop.listing_purpose_id = 1; -- Assuming '1' is for 'For Sale'