-- 1. Fix property_type_scope for amenities that were incorrectly set to 'Both'
--    but are exclusively relevant to residential properties.
update lookup_amenities set property_type_scope = 'Residential' where id in (65, 69, 81, 90, 113, 114, 120);

-- 2. Resolve Private Garden inconsistency: id 111 ('Private Garden') was 'Both'
--    while id 16 ('Private Garden / Terrace') was 'Residential'. Both are residential.
update lookup_amenities set property_type_scope = 'Residential' where id = 111;

-- 3. Add common land plot features that exist on major Indian real estate platforms
--    (Plot characteristics)
insert into public.lookup_land_features (name) values
    ('East Facing Plot'),
    ('North Facing Plot'),
    ('Wide Road Frontage'),
    ('Park Facing Plot')
on conflict (name) do nothing;

--    (Utilities at site)
insert into public.lookup_land_features (name) values
    ('Electricity Connection'),
    ('Water Connection'),
    ('Sewage Connection')
on conflict (name) do nothing;

--    (Access & Location)
insert into public.lookup_land_features (name) values
    ('Heavy Vehicle Access'),
    ('Township Plot'),
    ('Lake View Plot'),
    ('Hill View Plot')
on conflict (name) do nothing;

--    (Legal / Approval)
insert into public.lookup_land_features (name) values
    ('Approved Building Plan'),
    ('Agricultural Well')
on conflict (name) do nothing;
