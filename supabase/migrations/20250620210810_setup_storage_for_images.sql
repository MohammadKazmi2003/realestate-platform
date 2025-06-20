-- 1. Create the storage bucket for property images if it doesn't exist.
-- We are making it a public bucket for easier access to images.
INSERT INTO storage.buckets (id, name, public)
VALUES ('property-images', 'property-images', true)
ON CONFLICT (id) DO NOTHING;


-- 2. Create RLS policies for the storage bucket.
-- These policies control who can do what with the files.

-- POLICY 1: Allow anonymous users to view all images in the bucket.
-- This is needed so that anyone Browse your site can see the property pictures.
CREATE POLICY "Allow public read access to property images"
ON storage.objects FOR SELECT
TO authenticated, anon
USING (bucket_id = 'property-images');

-- POLICY 2: Allow authenticated (logged-in) users to upload images.
-- This policy checks that the user is trying to upload into a folder named with their own user ID.
-- This is the crucial policy that fixes your "400 Bad Request" error.
CREATE POLICY "Allow authenticated users to upload their own images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'property-images' AND
  auth.uid() = (storage.foldername(name))[1]::uuid
);

-- POLICY 3: Allow users to update their own images.
CREATE POLICY "Allow users to update their own images"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'property-images' AND
  auth.uid() = (storage.foldername(name))[1]::uuid
);

-- POLICY 4: Allow users to delete their own images.
CREATE POLICY "Allow users to delete their own images"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'property-images' AND
  auth.uid() = (storage.foldername(name))[1]::uuid
);