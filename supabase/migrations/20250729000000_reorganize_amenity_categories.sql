-- Reorganize lookup_amenities into balanced, intuitive groups.
-- No amenities added, removed, or renamed. Only the category field changes.
-- The frontend AccordionChecklist component reads category from the API
-- and groups items automatically — zero frontend changes needed.

-- 1. Parking & Transport (11)
update lookup_amenities set category = 'Parking & Transport' where id in (4,41,47,48,80,88,95,98,104,120,128);

-- 2. Security & Safety (7)
update lookup_amenities set category = 'Security & Safety' where id in (3,7,25,60,68,125,126);

-- 3. Recreation & Fitness (21)
update lookup_amenities set category = 'Recreation & Fitness' where id in (22,23,39,52,56,61,62,69,72,74,84,85,89,91,92,97,106,107,109,113,122);

-- 4. Community & Social (15)
update lookup_amenities set category = 'Community & Social' where id in (21,24,36,40,42,45,51,59,66,71,94,101,105,115,123);

-- 5. Outdoor & Scenic (17)
update lookup_amenities set category = 'Outdoor & Scenic' where id in (6,16,33,37,49,58,73,77,82,83,86,110,111,112,116,119,130);

-- 6. Premium & Luxury (9)
update lookup_amenities set category = 'Premium & Luxury' where id in (5,38,53,64,75,76,99,117,118);

-- 7. Family & Convenience (10)
update lookup_amenities set category = 'Family & Convenience' where id in (35,46,57,65,81,90,93,103,114,124);

-- 8. Services & Staff (7)
update lookup_amenities set category = 'Services & Staff' where id in (1,26,43,54,79,96,102);

-- 9. Property Features (17)
update lookup_amenities set category = 'Property Features' where id in (8,9,10,13,15,17,18,19,34,50,55,63,67,70,78,108,129);

-- 10. Utilities & Infrastructure (9)
update lookup_amenities set category = 'Utilities & Infrastructure' where id in (2,11,12,14,20,27,28,29,127);

-- 11. Office & Business (6)
update lookup_amenities set category = 'Office & Business' where id in (30,31,32,44,87,100);
