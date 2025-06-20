-- Create the user_favorites table to store which users have favorited which properties
CREATE TABLE public.user_favorites (
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (user_id, property_id)
);

-- Enable Row Level Security on the new table
ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;

-- Create policies for the user_favorites table
-- 1. Users can view their own favorites.
CREATE POLICY "Users can view their own favorites."
    ON public.user_favorites FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- 2. Users can insert their own favorites.
CREATE POLICY "Users can insert their own favorites."
    ON public.user_favorites FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- 3. Users can delete their own favorites.
CREATE POLICY "Users can delete their own favorites."
    ON public.user_favorites FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);