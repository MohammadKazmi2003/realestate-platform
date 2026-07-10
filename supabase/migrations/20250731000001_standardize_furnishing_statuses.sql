-- Standardize furnishing statuses. The migration added 'Furnished', 'Semi-furnished',
-- 'Un-furnished'. The seed.sql added 'Fully Furnished', 'Semi Furnished', 'Unfurnished'.
-- Keeping only the latter three, which are the canonical industry-standard names.

-- Reassign existing properties using old statuses to the new standard ones
update details_residential set furnishing_status_id = 4 where furnishing_status_id = 1; -- Furnished → Fully Furnished
update details_residential set furnishing_status_id = 5 where furnishing_status_id = 2; -- Semi-furnished → Semi Furnished
update details_residential set furnishing_status_id = 6 where furnishing_status_id = 3; -- Un-furnished → Unfurnished

-- Remove the old duplicates
delete from lookup_furnishing_statuses where id = 1; -- Furnished
delete from lookup_furnishing_statuses where id = 2; -- Semi-furnished
delete from lookup_furnishing_statuses where id = 3; -- Un-furnished
