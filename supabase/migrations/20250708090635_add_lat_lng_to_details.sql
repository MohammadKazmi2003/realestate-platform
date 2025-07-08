-- This migration updates the get_property_details function to extract and
-- return latitude and longitude from the location_point geography type.

-- First, DROP the old function to avoid conflicts.
DROP FUNCTION IF EXISTS public.get_property_details(uuid);

-- Then, CREATE the new, corrected version of the function.
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
        'latitude', ST_Y(p.location_point::geometry),   -- ADDED: Extract Latitude
        'longitude', ST_X(p.location_point::geometry), -- ADDED: Extract Longitude
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
