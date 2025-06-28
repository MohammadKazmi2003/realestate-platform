-- Creates a lookup table for land-specific features and a junction table.

-- 1. Create the lookup table for land features.
CREATE TABLE IF NOT EXISTS public.lookup_land_features (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

-- 2. Populate the new lookup table with relevant features.
INSERT INTO public.lookup_land_features (name) VALUES
    ('Corner Plot'),
    ('Road-touch Land'),
    ('Gated Community'),
    ('Fenced Boundary')
ON CONFLICT (name) DO NOTHING;

-- 3. Create the junction table to link properties to land features.
CREATE TABLE IF NOT EXISTS public.junction_property_land_features (
    property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
    feature_id INT NOT NULL REFERENCES public.lookup_land_features(id) ON DELETE CASCADE,
    PRIMARY KEY (property_id, feature_id)
);

-- 4. Enable RLS on the new junction table.
ALTER TABLE public.junction_property_land_features ENABLE ROW LEVEL SECURITY;

-- 5. Create policies for the new junction table.
CREATE POLICY "Users can manage their own property land features"
    ON public.junction_property_land_features
    FOR ALL
    TO authenticated
    USING (auth.uid() = (SELECT user_id FROM properties WHERE id = property_id))
    WITH CHECK (auth.uid() = (SELECT user_id FROM properties WHERE id = property_id));

-- Note: No changes are needed for the get_property_details function at this time,
-- as this is for the add-property page. We can add this to the function later if needed for display.
