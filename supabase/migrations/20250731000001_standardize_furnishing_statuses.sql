-- Standardize furnishing statuses. The migration added 'Furnished', 'Semi-furnished',
-- 'Un-furnished'. The seed.sql added 'Fully Furnished', 'Semi Furnished', 'Unfurnished'.
-- Keeping only the latter three, which are the canonical industry-standard names.

-- Reassign existing properties using old statuses to the new standard ones.
-- Guarded: remote was partly seeded by hand, so canonical ids 4/5/6 may not
-- exist there. Reassign only where the target exists (else the FK aborts the
-- whole push), and delete legacy ids only when nothing references them.
DO $$
BEGIN
  UPDATE details_residential SET furnishing_status_id = 4 WHERE furnishing_status_id = 1 AND EXISTS (SELECT 1 FROM lookup_furnishing_statuses WHERE id = 4); -- Furnished → Fully Furnished
  UPDATE details_residential SET furnishing_status_id = 5 WHERE furnishing_status_id = 2 AND EXISTS (SELECT 1 FROM lookup_furnishing_statuses WHERE id = 5); -- Semi-furnished → Semi Furnished
  UPDATE details_residential SET furnishing_status_id = 6 WHERE furnishing_status_id = 3 AND EXISTS (SELECT 1 FROM lookup_furnishing_statuses WHERE id = 6); -- Un-furnished → Unfurnished

  -- Remove the old duplicates
  DELETE FROM lookup_furnishing_statuses WHERE id IN (1, 2, 3)
    AND NOT EXISTS (SELECT 1 FROM details_residential WHERE furnishing_status_id IN (1, 2, 3));
END $$;
