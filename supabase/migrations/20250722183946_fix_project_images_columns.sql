-- Migration: fix_project_images_columns.sql
-- Adds missing columns to the project_images table to fully align with the scraper schema.

ALTER TABLE public.project_images
    ADD COLUMN IF NOT EXISTS storage_path_medium text,
    ADD COLUMN IF NOT EXISTS storage_path_thumbnail text;