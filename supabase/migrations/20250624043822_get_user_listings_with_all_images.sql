-- Function to get all listings for a specific user.
CREATE OR REPLACE FUNCTION get_user_listings_with_all_images(p_user_id uuid)
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
        prof.phone_number as owner_phone,
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
    WHERE
        p.user_id = p_user_id
    ORDER BY
        p.created_at DESC;
END;
$$;
