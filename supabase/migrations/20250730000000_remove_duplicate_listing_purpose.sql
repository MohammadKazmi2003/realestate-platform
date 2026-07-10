-- The migration inserts 'Sell', 'Rent', 'Lease', 'PG'.
-- The seed.sql inserts 'Sale', 'Rent', 'Lease', 'PG'.
-- 'Sale' and 'Sell' are duplicates. Removing 'Sale'.

delete from public.lookup_listing_purposes where id = 5;
