-- Migration: final_project_schema_sync.sql
-- This script is idempotent and fully aligns the platform database with the scraper's schema.

-- ========= SECTION 1: CREATE ALL MISSING LOOKUP AND CORE TABLES =========

-- Use IF NOT EXISTS to prevent errors on re-runs.
CREATE TABLE IF NOT EXISTS public.developers (
    id uuid NOT NULL DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
    pf_developer_id text UNIQUE,
    name text NOT NULL,
    slug text UNIQUE,
    logo_storage_path text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.amenities (
    id uuid NOT NULL DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
    name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS public.locations (
    id uuid NOT NULL DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
    name text NOT NULL,
    slug text NOT NULL,
    level text,
    parent_id uuid REFERENCES public.locations(id)
);

-- ========= SECTION 2: MODIFY THE EXISTING PROJECTS TABLE =========

-- Use ADD COLUMN IF NOT EXISTS for all new columns.
ALTER TABLE public.projects
    ADD COLUMN IF NOT EXISTS scraper_pf_project_id text UNIQUE,
    ADD COLUMN IF NOT EXISTS developer_id uuid REFERENCES public.developers(id) ON DELETE SET NULL,
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
    ADD COLUMN IF NOT EXISTS latitude numeric(10, 7),
    ADD COLUMN IF NOT EXISTS longitude numeric(10, 7),
    ADD COLUMN IF NOT EXISTS master_plan_description text,
    ADD COLUMN IF NOT EXISTS master_plan_storage_path text;


-- ========= SECTION 3: CREATE TABLES FOR PROJECT-SPECIFIC DETAILS (1-to-Many) =========

CREATE TABLE IF NOT EXISTS public.project_images (
    id uuid NOT NULL DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    storage_path_original text NOT NULL,
    storage_path_medium text,
    storage_path_thumbnail text,
    is_primary boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.project_videos (
    id uuid NOT NULL DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    video_storage_path text NOT NULL,
    thumbnail_storage_path text
);

CREATE TABLE IF NOT EXISTS public.unit_configurations (
    id uuid NOT NULL DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    property_type text NOT NULL,
    bedrooms integer,
    area_from_sqft numeric,
    area_to_sqft numeric,
    starting_price numeric,
    floor_plan_urls jsonb
);

CREATE TABLE IF NOT EXISTS public.payment_plans (
    id uuid NOT NULL DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    title text,
    milestone text NOT NULL,
    percentage numeric NOT NULL
);

CREATE TABLE IF NOT EXISTS public.faqs (
    id uuid NOT NULL DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    question text NOT NULL,
    answer text NOT NULL
);

-- ========= SECTION 4: CREATE JUNCTION TABLES (Many-to-Many) =========

CREATE TABLE IF NOT EXISTS public.project_amenities (
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    amenity_id uuid NOT NULL REFERENCES public.amenities(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, amenity_id)
);

CREATE TABLE IF NOT EXISTS public.project_locations (
    project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, location_id)
);

-- ========= SECTION 5: APPLY ROW-LEVEL SECURITY (RLS) =========

-- Drop policies if they exist before creating them to prevent errors.
ALTER TABLE public.developers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to developers" ON public.developers;
CREATE POLICY "Allow public read access to developers" ON public.developers FOR SELECT USING (true);

ALTER TABLE public.amenities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to amenities" ON public.amenities;
CREATE POLICY "Allow public read access to amenities" ON public.amenities FOR SELECT USING (true);

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to locations" ON public.locations;
CREATE POLICY "Allow public read access to locations" ON public.locations FOR SELECT USING (true);

ALTER TABLE public.project_images ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to project images" ON public.project_images;
CREATE POLICY "Allow public read access to project images" ON public.project_images FOR SELECT USING (true);

ALTER TABLE public.project_videos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to project videos" ON public.project_videos;
CREATE POLICY "Allow public read access to project videos" ON public.project_videos FOR SELECT USING (true);

ALTER TABLE public.unit_configurations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to unit configurations" ON public.unit_configurations;
CREATE POLICY "Allow public read access to unit configurations" ON public.unit_configurations FOR SELECT USING (true);

ALTER TABLE public.payment_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to payment plans" ON public.payment_plans;
CREATE POLICY "Allow public read access to payment plans" ON public.payment_plans FOR SELECT USING (true);

ALTER TABLE public.faqs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to faqs" ON public.faqs;
CREATE POLICY "Allow public read access to faqs" ON public.faqs FOR SELECT USING (true);

ALTER TABLE public.project_amenities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to project amenities" ON public.project_amenities;
CREATE POLICY "Allow public read access to project amenities" ON public.project_amenities FOR SELECT USING (true);

ALTER TABLE public.project_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to project locations" ON public.project_locations;
CREATE POLICY "Allow public read access to project locations" ON public.project_locations FOR SELECT USING (true);

-- Ensure the main projects table also has a public read policy
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to projects" ON public.projects;
CREATE POLICY "Allow public read access to projects" ON public.projects FOR SELECT USING (true);
