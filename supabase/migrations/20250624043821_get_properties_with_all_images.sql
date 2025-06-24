-- General function to get properties (e.g., for the homepage).
-- This version replaces the old one and now includes all images.
CREATE OR REPLACE FUNCTION get_properties_with_all_images()
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    area_sqft numeric,
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
        COALESCE(dr.carpet_area, dc.carpet_area) AS area_sqft,
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
    ORDER BY
        p.created_at DESC
    LIMIT 12; -- Limit for the homepage
END;
$$;
