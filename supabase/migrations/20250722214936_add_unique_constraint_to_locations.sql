-- Migration: add_unique_constraint_to_locations.sql
-- Adds the missing unique constraint to the locations table to support the upsert operation.

ALTER TABLE public.locations
ADD CONSTRAINT locations_slug_key UNIQUE (slug);