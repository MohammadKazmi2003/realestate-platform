-- Add indexes to columns used in the search_projects function to improve query performance.

-- Index for price-based sorting and filtering
CREATE INDEX IF NOT EXISTS idx_projects_low_price ON public.projects(low_price);

-- Index for delivery date sorting and filtering
CREATE INDEX IF NOT EXISTS idx_projects_delivery_date ON public.projects(delivery_date);

-- Index for completion status filtering
CREATE INDEX IF NOT EXISTS idx_projects_construction_phase ON public.projects(construction_phase);

-- Index on the foreign key in unit_configurations for bedroom filtering
CREATE INDEX IF NOT EXISTS idx_unit_configurations_project_id ON public.unit_configurations(project_id);

-- Index on the foreign key in project_amenities for amenity filtering
CREATE INDEX IF NOT EXISTS idx_project_amenities_project_id ON public.project_amenities(project_id);

