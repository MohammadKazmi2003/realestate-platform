-- This function returns a distinct list of all 'construction_phase' values
-- currently present in the projects table. This is used to populate the
-- "Completion Status" filter on the /newprojects page.

CREATE OR REPLACE FUNCTION distinct_completion_status()
RETURNS TABLE (construction_phase TEXT)
LANGUAGE sql
STABLE
AS $$
    SELECT DISTINCT p.construction_phase
    FROM public.projects p
    WHERE p.construction_phase IS NOT NULL AND p.construction_phase <> '';
$$;
