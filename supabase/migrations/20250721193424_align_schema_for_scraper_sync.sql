-- Migration: align_schema_for_scraper_sync.sql

-- ========= SECTION 1: CREATE NEW TABLES =========

-- Create the Developers table to store builder information
CREATE TABLE public.developers (
    id uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
    pf_developer_id text UNIQUE, -- Unique ID from the scraper source
    name text NOT NULL,
    slug text UNIQUE,
    logo_storage_path text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Create table for project-specific images
CREATE TABLE public.project_images (
    id uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    storage_path_original text NOT NULL,
    is_primary boolean DEFAULT false
);

-- Create table for different unit types within a project
CREATE TABLE public.unit_configurations (
    id uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    property_type text NOT NULL,
    bedrooms integer,
    area_from_sqft numeric,
    area_to_sqft numeric,
    starting_price numeric,
    floor_plan_urls jsonb
);

-- Create table for project FAQs
CREATE TABLE public.faqs (
    id uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    question text NOT NULL,
    answer text NOT NULL
);

-- ========= SECTION 2: MODIFY EXISTING PROJECTS TABLE =========

-- Add new columns to the existing 'projects' table to match scraper data.
-- Prefixed with 'scraper_' to identify the data source.
ALTER TABLE public.projects
    ADD COLUMN IF NOT EXISTS scraper_pf_project_id text UNIQUE,
    ADD COLUMN IF NOT EXISTS developer_id uuid REFERENCES public.developers(id),
    ADD COLUMN IF NOT EXISTS slug text UNIQUE,
    ADD COLUMN IF NOT EXISTS description_html text,
    ADD COLUMN IF NOT EXISTS construction_phase text,
    ADD COLUMN IF NOT EXISTS construction_progress_percent integer,
    ADD COLUMN IF NOT EXISTS delivery_date timestamptz,
    ADD COLUMN IF NOT EXISTS low_price numeric,
    ADD COLUMN IF NOT EXISTS high_price numeric,
    ADD COLUMN IF NOT EXISTS price_currency text,
    ADD COLUMN IF NOT EXISTS brochure_storage_path text,
    ADD COLUMN IF NOT EXISTS is_verified boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS latitude numeric,
    ADD COLUMN IF NOT EXISTS longitude numeric,
    ADD COLUMN IF NOT EXISTS master_plan_description text,
    ADD COLUMN IF NOT EXISTS master_plan_storage_path text;

-- ========= SECTION 3: APPLY ROW-LEVEL SECURITY (RLS) =========

-- Enable RLS and set public read-only policies for all new and modified tables.
-- This allows your website visitors to see the data, while writes are restricted.
ALTER TABLE public.developers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to developers" ON public.developers FOR SELECT USING (true);

ALTER TABLE public.project_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to project images" ON public.project_images FOR SELECT USING (true);

ALTER TABLE public.unit_configurations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to unit configurations" ON public.unit_configurations FOR SELECT USING (true);

ALTER TABLE public.faqs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to faqs" ON public.faqs FOR SELECT USING (true);

-- Ensure the projects table also has RLS enabled and is publicly readable.
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read access to projects" ON public.projects FOR SELECT USING (true);