-- This function searches for properties based on various filters,
-- including map boundaries, and is used by the browse page.
CREATE OR REPLACE FUNCTION public.search_properties(
    p_location_text text DEFAULT NULL,
    p_min_price numeric DEFAULT NULL,
    p_max_price numeric DEFAULT NULL,
    p_bhk_type_id int DEFAULT NULL,
    p_property_type_id int DEFAULT NULL,
    min_lat double precision DEFAULT NULL,
    max_lat double precision DEFAULT NULL,
    min_lng double precision DEFAULT NULL,
    max_lng double precision DEFAULT NULL
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
    bhk_type_label text,
    bathrooms int,
    balconies int,
    cabins int,
    workstations int,
    owner_phone text,
    user_id uuid,
    image_url text, -- Returns a single image URL for the card preview
    property_type_name text
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
        ST_Y(p.location_point::geometry) as latitude,
        ST_X(p.location_point::geometry) as longitude,
        COALESCE(dl.plot_area, dr.carpet_area, dc.carpet_area) AS area,
        COALESCE(dl.area_unit, 'sqft') AS area_unit,
        bt.label as bhk_type_label,
        dr.bathrooms,
        dr.balconies,
        dc.cabins,
        dc.workstations,
        prof.phone_number AS owner_phone,
        p.user_id,
        (
            SELECT pm.media_url
            FROM property_media pm
            WHERE pm.property_id = p.id
            ORDER BY pm.display_order
            LIMIT 1
        ) AS image_url,
        pt.name as property_type_name
    FROM
        properties p
    LEFT JOIN property_types pt ON p.property_type_id = pt.id
    LEFT JOIN profiles prof ON p.user_id = prof.id
    LEFT JOIN details_residential dr ON p.id = dr.property_id
    LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id
    LEFT JOIN details_commercial dc ON p.id = dc.property_id
    LEFT JOIN details_land dl ON p.id = dl.property_id
    WHERE
        (p_location_text IS NULL OR p.location_text ILIKE '%' || p_location_text || '%')
    AND (p_min_price IS NULL OR p.price >= p_min_price)
    AND (p_max_price IS NULL OR p.price <= p_max_price)
    AND (p_bhk_type_id IS NULL OR dr.bhk_type_id = p_bhk_type_id)
    AND (p_property_type_id IS NULL OR p.property_type_id = p_property_type_id)
    AND (
        min_lat IS NULL OR -- If no map bounds are provided, this filter is ignored
        (p.location_point IS NOT NULL AND ST_Intersects(
            p.location_point::geometry,
            ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
        ))
    )
    ORDER BY p.created_at DESC;
END;
$$;

-- Enable Row Level Security on the main properties table.
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows public, read-only access to all properties.
-- This is necessary so that anyone (logged in or not) can view listings.
CREATE POLICY "Allow public read-only access to properties"
ON public.properties
FOR SELECT
TO anon, authenticated
USING (true);
