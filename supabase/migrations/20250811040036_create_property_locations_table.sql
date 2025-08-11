-- This migration creates the missing 'property_locations' join table,
-- which is required for the hierarchical location search to function correctly.

-- Create the many-to-many join table between properties and locations
CREATE TABLE public.property_locations (
    property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    PRIMARY KEY (property_id, location_id)
);

-- Add indexes for faster lookups
CREATE INDEX ON public.property_locations (property_id);
CREATE INDEX ON public.property_locations (location_id);

-- Enable Row Level Security
ALTER TABLE public.property_locations ENABLE ROW LEVEL SECURITY;

-- Allow public read access to the location links
CREATE POLICY "Enable public read access for all users"
ON public.property_locations
FOR SELECT
USING (true);

-- After creating this table, you will need to populate it with data.
-- For example, to link a property to the 'Downtown Dubai' location, you would run:
--
-- INSERT INTO public.property_locations (property_id, location_id)
-- VALUES
--   ('your-property-uuid', (SELECT id FROM public.locations WHERE name = 'Downtown Dubai'));

