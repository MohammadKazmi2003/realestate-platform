CREATE OR REPLACE FUNCTION get_listing_details(p_listing_id UUID)
RETURNS JSONB AS $$
DECLARE
    listing_details JSONB;
    listing_type_from_view TEXT;
BEGIN
    -- First, determine if the ID belongs to a 'property' or a 'project'
    SELECT listing_type INTO listing_type_from_view FROM unified_listings_view WHERE id = p_listing_id;

    -- If it's a 'property', use the detailed property fetching logic
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
        WHERE
            p.id = p_listing_id
        GROUP BY
            p.id, prof.id, pt.id, llp.id, las.id, lot.id;

    -- If it's a 'project', use the project fetching logic
    ELSIF listing_type_from_view = 'project' THEN
        SELECT
            jsonb_build_object(
                'id', proj.id,
                'type', 'project',
                'title', proj.name,
                'description', proj.description,
                'price_range', jsonb_build_object(
                    'low', proj.low_price,
                    'high', proj.high_price,
                    'currency', proj.price_currency
                ),
                'location_text', loc.name,
                'developer', to_jsonb(dev),
                'status', jsonb_build_object(
                    'phase', proj.construction_phase,
                    'progress_percent', proj.construction_progress_percent,
                    'delivery_date', proj.delivery_date
                ),
                'property_types', (SELECT COALESCE(jsonb_agg(pt.name), '[]'::jsonb) FROM unit_configurations uc JOIN property_types pt ON uc.property_type = pt.name WHERE uc.project_id = proj.id),
                'project_media', (SELECT COALESCE(jsonb_agg(pm.*), '[]'::jsonb) FROM project_images pm WHERE pm.project_id = proj.id),
                -- *** FIX: Join with the correct 'amenities' table instead of 'lookup_amenities' ***
                'amenities', (SELECT COALESCE(jsonb_agg(a.*), '[]'::jsonb) FROM project_amenities pa JOIN amenities a ON pa.amenity_id = a.id WHERE pa.project_id = proj.id)
            )
        INTO listing_details
        FROM
            projects proj
        LEFT JOIN developers dev ON proj.developer_id = dev.id
        LEFT JOIN project_locations pl ON proj.id = pl.project_id
        LEFT JOIN locations loc ON pl.location_id = loc.id
        WHERE
            proj.id = p_listing_id;
    END IF;

    RETURN listing_details;
END;
$$ LANGUAGE plpgsql;

