-- Allow owners to delete their own listings.
-- Without this, RLS silently deletes 0 rows: the client sees no error,
-- optimistically removes the card, and the property "loads back" on refetch.
DROP POLICY IF EXISTS "Allow owners to delete their own listings" ON public.properties;
CREATE POLICY "Allow owners to delete their own listings"
ON public.properties FOR DELETE
USING (auth.uid() = user_id);
