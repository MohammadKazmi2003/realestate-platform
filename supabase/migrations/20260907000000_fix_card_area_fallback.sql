-- Fix card area fallback to include built_up/super_built_up like search_properties.
-- Card RPCs previously used COALESCE(plot, carpet) only, hiding area when
-- only built_up/super_built_up was entered.
DROP FUNCTION IF EXISTS public.get_properties_with_all_images();
CREATE OR REPLACE FUNCTION public.get_properties_with_all_images()
RETURNS TABLE(id uuid, title text, price numeric, location_text text, area numeric, area_unit text, area_sqft numeric, bhk_type_label text, bedrooms int, bathrooms int, balconies int, cabins int, workstations int, furnishing_status text, listing_purpose text, owner_phone text, user_id uuid, images jsonb, property_type_name text)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT p.id, p.title, p.price, p.location_text,
    COALESCE(dl.plot_area, dr.carpet_area, dr.built_up_area, dr.super_built_up_area, dc.carpet_area),
    COALESCE(dl.area_unit, 'sqft'),
    COALESCE(dl.plot_area, dr.carpet_area, dr.built_up_area, dr.super_built_up_area, dc.carpet_area),
    bt.label,
    CASE WHEN bt.label ILIKE 'studio%' THEN 0 WHEN bt.label ~ '(\d+(\.\d+)?)' THEN FLOOR((regexp_match(bt.label, '(\d+(\.\d+)?)'))[1]::numeric)::int ELSE NULL END,
    dr.bathrooms, dr.balconies, dc.cabins, COALESCE(dc.workstations, dc.max_seats),
    COALESCE(fs_r.name, fs_c.name), lp.name, prof.phone_number, p.user_id,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('image_url', pm.media_url)), '[]'::jsonb) FROM property_media pm WHERE pm.property_id = p.id),
    pt.name
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
  ORDER BY p.created_at DESC LIMIT 12;
END; $$;

DROP FUNCTION IF EXISTS public.get_all_listings_paginated(text, int, int, text, int, int);
CREATE OR REPLACE FUNCTION get_all_listings_paginated(p_location_text text, p_bhk_type_id int, p_property_type_id int, p_sort_by text, p_page_num int, p_items_per_page int)
RETURNS TABLE(id uuid, title text, price numeric, location_text text, area numeric, area_unit text, area_sqft numeric, bhk_type_label text, bedrooms int, bathrooms int, balconies int, cabins int, workstations int, furnishing_status text, listing_purpose text, owner_phone text, user_id uuid, images jsonb, property_type_name text)
LANGUAGE plpgsql AS $$
DECLARE v_offset int;
BEGIN
  v_offset := (p_page_num - 1) * p_items_per_page;
  RETURN QUERY SELECT p.id, p.title, p.price, p.location_text,
    COALESCE(dl.plot_area, dr.carpet_area, dr.built_up_area, dr.super_built_up_area, dc.carpet_area),
    COALESCE(dl.area_unit, 'sqft'),
    COALESCE(dl.plot_area, dr.carpet_area, dr.built_up_area, dr.super_built_up_area, dc.carpet_area),
    bt.label,
    CASE WHEN bt.label ILIKE 'studio%' THEN 0 WHEN bt.label ~ '(\d+(\.\d+)?)' THEN FLOOR((regexp_match(bt.label, '(\d+(\.\d+)?)'))[1]::numeric)::int ELSE NULL END,
    dr.bathrooms, dr.balconies, dc.cabins, COALESCE(dc.workstations, dc.max_seats),
    COALESCE(fs_r.name, fs_c.name), lp.name, prof.phone_number, p.user_id,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('image_url', pm.media_url)), '[]'::jsonb) FROM property_media pm WHERE pm.property_id = p.id),
    pt.name
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
  WHERE (p_location_text IS NULL OR p.location_text ILIKE '%' || p_location_text || '%')
  AND (p_bhk_type_id IS NULL OR dr.bhk_type_id = p_bhk_type_id)
  AND (p_property_type_id IS NULL OR p.property_type_id = p_property_type_id)
  ORDER BY CASE WHEN p_sort_by = 'created_at' THEN p.created_at END DESC, CASE WHEN p_sort_by = 'price_asc' THEN p.price END ASC, CASE WHEN p_sort_by = 'price_desc' THEN p.price END DESC
  LIMIT p_items_per_page OFFSET v_offset;
END; $$;
