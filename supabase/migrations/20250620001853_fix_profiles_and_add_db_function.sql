-- Create the missing profiles table
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  email text UNIQUE,
  phone_number text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Drop the old, incorrect foreign key from properties -> auth.users
ALTER TABLE public.properties 
DROP CONSTRAINT IF EXISTS properties_user_id_fkey;

-- Add the new, correct foreign key from properties -> profiles
ALTER TABLE public.properties 
ADD CONSTRAINT properties_user_id_fkey 
FOREIGN KEY (user_id) REFERENCES public.profiles(id);

-- Create the database function that will handle new listings
CREATE OR REPLACE FUNCTION public.create_new_listing(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_property_id uuid;
BEGIN
    -- Insert into the main properties table
    INSERT INTO public.properties (
        user_id,
        property_type_id,
        listing_purpose_id,
        title,
        description,
        price
        -- Note: We would expand this to include all fields from the payload
    )
    VALUES (
        auth.uid(),
        (payload->'propertyTypeId')::int,
        (payload->'commonData'->>'listing_purpose_id')::int,
        payload->'commonData'->>'title',
        payload->'commonData'->>'description',
        (payload->'commonData'->>'price')::numeric
    )
    RETURNING id INTO new_property_id;

    -- Placeholder for inserting into details and junction tables
    -- This logic will be fully implemented in the next coding step

    RETURN new_property_id;
END;
$$;