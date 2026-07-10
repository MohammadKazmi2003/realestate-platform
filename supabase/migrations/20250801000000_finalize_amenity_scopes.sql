-- Final pass on amenity property_type_scope corrections.
-- Balcony, Built in Wardrobes, Walk-in Closet, Work and Study, Study
-- are residential features — not applicable to commercial properties.

update lookup_amenities set property_type_scope = 'Residential' where id in (35, 46, 63, 110, 117);
