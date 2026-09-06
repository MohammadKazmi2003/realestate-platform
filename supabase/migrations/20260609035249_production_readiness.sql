-- Production Readiness Migration
-- Adds critical indexes, full-text search, platform settings, and performance foundations

-- 1. Extensions (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- 2. Spatial GiST index on location_point (critical for map-bound search)
CREATE INDEX IF NOT EXISTS idx_properties_location_point
ON public.properties USING GIST (location_point);

-- 3. B-tree indexes for common filter and sort columns
CREATE INDEX IF NOT EXISTS idx_properties_price
ON public.properties (price);

CREATE INDEX IF NOT EXISTS idx_properties_created_at
ON public.properties (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_properties_property_type_id
ON public.properties (property_type_id);

CREATE INDEX IF NOT EXISTS idx_properties_listing_purpose_id
ON public.properties (listing_purpose_id);

CREATE INDEX IF NOT EXISTS idx_properties_user_id
ON public.properties (user_id);

CREATE INDEX IF NOT EXISTS idx_properties_status
ON public.properties (status);

-- 4. Trigram GIN index on location_text for ILIKE queries.
-- Opclass is schema-qualified: db-push sessions don't have extensions/ on
-- search_path, so the unqualified name fails remotely while working in Studio.
CREATE INDEX IF NOT EXISTS idx_properties_location_text_trgm
ON public.properties USING GIN (location_text extensions.gin_trgm_ops);

-- 5. B-tree indexes on foreign key columns in secondary tables
CREATE INDEX IF NOT EXISTS idx_leads_property_id
ON public.leads (property_id);

CREATE INDEX IF NOT EXISTS idx_leads_status
ON public.leads (status);

CREATE INDEX IF NOT EXISTS idx_event_logs_property_id
ON public.event_logs (property_id);

CREATE INDEX IF NOT EXISTS idx_event_logs_event_type
ON public.event_logs (event_type);

CREATE INDEX IF NOT EXISTS idx_event_logs_user_id
ON public.event_logs (user_id);

CREATE INDEX IF NOT EXISTS idx_action_logs_user_id
ON public.action_logs (user_id);

CREATE INDEX IF NOT EXISTS idx_action_logs_entity_type
ON public.action_logs (entity_type);

CREATE INDEX IF NOT EXISTS idx_appointments_agent_id
ON public.appointments (agent_id);

CREATE INDEX IF NOT EXISTS idx_appointments_appointment_date
ON public.appointments (appointment_date);

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_id
ON public.lead_notes (lead_id);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user_id
ON public.user_favorites (user_id);

CREATE INDEX IF NOT EXISTS idx_property_media_property_id
ON public.property_media (property_id);

-- 6. Full-text search: tsvector column and GIN index on properties
ALTER TABLE public.properties
ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION public.properties_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.location_text, '')), 'B');
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_properties_search_vector
    BEFORE INSERT OR UPDATE OF title, description, location_text
    ON public.properties
    FOR EACH ROW
    EXECUTE FUNCTION public.properties_search_vector_update();

-- Backfill existing rows
UPDATE public.properties SET search_vector =
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(location_text, '')), 'B')
WHERE search_vector IS NULL;

CREATE INDEX IF NOT EXISTS idx_properties_search_vector
ON public.properties USING GIN (search_vector);

-- 7. Full-text search RPC function
CREATE OR REPLACE FUNCTION public.full_text_search_properties(
    p_query text,
    p_min_price numeric DEFAULT NULL,
    p_max_price numeric DEFAULT NULL,
    p_property_type_id int DEFAULT NULL,
    p_bhk_type_id int DEFAULT NULL,
    p_listing_purpose_id int DEFAULT NULL,
    p_page int DEFAULT 1,
    p_limit int DEFAULT 24
)
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    latitude double precision,
    longitude double precision,
    area numeric,
    area_unit text,
    bhk_type_label text,
    bathrooms int,
    balconies int,
    cabins int,
    workstations int,
    owner_phone text,
    user_id uuid,
    image_url text,
    property_type_name text,
    rank real
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_offset int;
    v_ts_query tsquery;
BEGIN
    v_offset := (p_page - 1) * p_limit;
    v_ts_query := plainto_tsquery('english', p_query);

    RETURN QUERY
    SELECT
        p.id, p.title, p.price, p.location_text,
        ST_Y(p.location_point::geometry) as latitude,
        ST_X(p.location_point::geometry) as longitude,
        COALESCE(dl.plot_area, dr.carpet_area, dc.carpet_area) AS area,
        COALESCE(dl.area_unit, 'sqft') AS area_unit,
        bt.label as bhk_type_label,
        dr.bathrooms, dr.balconies,
        dc.cabins, dc.workstations,
        prof.phone_number AS owner_phone,
        p.user_id,
        (SELECT pm.media_url FROM property_media pm
         WHERE pm.property_id = p.id ORDER BY pm.display_order LIMIT 1) AS image_url,
        pt.name as property_type_name,
        ts_rank(p.search_vector, v_ts_query) AS rank
    FROM properties p
    LEFT JOIN property_types pt ON p.property_type_id = pt.id
    LEFT JOIN profiles prof ON p.user_id = prof.id
    LEFT JOIN details_residential dr ON p.id = dr.property_id
    LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id
    LEFT JOIN details_commercial dc ON p.id = dc.property_id
    LEFT JOIN details_land dl ON p.id = dl.property_id
    WHERE
        (v_ts_query IS NULL OR p.search_vector @@ v_ts_query)
    AND (p_min_price IS NULL OR p.price >= p_min_price)
    AND (p_max_price IS NULL OR p.price <= p_max_price)
    AND (p_property_type_id IS NULL OR p.property_type_id = p_property_type_id)
    AND (p_bhk_type_id IS NULL OR dr.bhk_type_id = p_bhk_type_id)
    AND (p_listing_purpose_id IS NULL OR p.listing_purpose_id = p_listing_purpose_id)
    AND p.status = 'available'
    ORDER BY
        CASE WHEN v_ts_query IS NOT NULL THEN ts_rank(p.search_vector, v_ts_query) ELSE 0 END DESC,
        p.created_at DESC
    LIMIT p_limit OFFSET v_offset;
END;
$$;

-- 8. Autocomplete RPC using pg_trgm similarity
CREATE OR REPLACE FUNCTION public.autocomplete_locations(
    p_prefix text,
    p_limit int DEFAULT 10
)
RETURNS TABLE(
    location_text text,
    project_name text,
    property_type text,
    similarity real
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        p.location_text,
        pr.name AS project_name,
        pt.name AS property_type,
        extensions.similarity(p.location_text, p_prefix) AS similarity
    FROM properties p
    LEFT JOIN projects pr ON p.project_id = pr.id
    LEFT JOIN property_types pt ON p.property_type_id = pt.id
    WHERE p.location_text OPERATOR(extensions.%) p_prefix
      AND p.status = 'available'
    ORDER BY extensions.similarity(p.location_text, p_prefix) DESC
    LIMIT p_limit;
$$;

-- 9. Improved search_properties with index utilization and cursor support
CREATE OR REPLACE FUNCTION public.search_properties(
    p_location_text text DEFAULT NULL,
    p_min_price numeric DEFAULT NULL,
    p_max_price numeric DEFAULT NULL,
    p_bhk_type_id int DEFAULT NULL,
    p_property_type_id int DEFAULT NULL,
    p_listing_purpose_id int DEFAULT NULL,
    min_lat double precision DEFAULT NULL,
    max_lat double precision DEFAULT NULL,
    min_lng double precision DEFAULT NULL,
    max_lng double precision DEFAULT NULL,
    p_search_query text DEFAULT NULL,
    p_cursor_created_at timestamptz DEFAULT NULL,
    p_cursor_id uuid DEFAULT NULL,
    p_limit int DEFAULT 24
)
RETURNS TABLE(
    id uuid,
    title text,
    price numeric,
    location_text text,
    latitude double precision,
    longitude double precision,
    area numeric,
    area_unit text,
    bhk_type_label text,
    bathrooms int,
    balconies int,
    cabins int,
    workstations int,
    owner_phone text,
    user_id uuid,
    image_url text,
    property_type_name text,
    rank real
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_ts_query tsquery;
BEGIN
    v_ts_query := CASE
        WHEN p_search_query IS NOT NULL AND p_search_query != ''
        THEN plainto_tsquery('english', p_search_query)
        ELSE NULL
    END;

    RETURN QUERY
    SELECT
        p.id, p.title, p.price, p.location_text,
        ST_Y(p.location_point::geometry) as latitude,
        ST_X(p.location_point::geometry) as longitude,
        COALESCE(dl.plot_area, dr.carpet_area, dc.carpet_area) AS area,
        COALESCE(dl.area_unit, 'sqft') AS area_unit,
        bt.label as bhk_type_label,
        dr.bathrooms, dr.balconies,
        dc.cabins, dc.workstations,
        prof.phone_number AS owner_phone,
        p.user_id,
        (SELECT pm.media_url FROM property_media pm
         WHERE pm.property_id = p.id ORDER BY pm.display_order LIMIT 1) AS image_url,
        pt.name as property_type_name,
        CASE WHEN v_ts_query IS NOT NULL
             THEN ts_rank(p.search_vector, v_ts_query)
             ELSE 0 END AS rank
    FROM properties p
    LEFT JOIN property_types pt ON p.property_type_id = pt.id
    LEFT JOIN profiles prof ON p.user_id = prof.id
    LEFT JOIN details_residential dr ON p.id = dr.property_id
    LEFT JOIN bhk_types bt ON dr.bhk_type_id = bt.id
    LEFT JOIN details_commercial dc ON p.id = dc.property_id
    LEFT JOIN details_land dl ON p.id = dl.property_id
    WHERE
        p.status = 'available'
    AND (p_location_text IS NULL OR p.location_text ILIKE '%' || p_location_text || '%')
    AND (p_min_price IS NULL OR p.price >= p_min_price)
    AND (p_max_price IS NULL OR p.price <= p_max_price)
    AND (p_bhk_type_id IS NULL OR dr.bhk_type_id = p_bhk_type_id)
    AND (p_property_type_id IS NULL OR p.property_type_id = p_property_type_id)
    AND (p_listing_purpose_id IS NULL OR p.listing_purpose_id = p_listing_purpose_id)
    AND (v_ts_query IS NULL OR p.search_vector @@ v_ts_query)
    AND (
        min_lat IS NULL OR
        (p.location_point IS NOT NULL AND p.location_point && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)::geography)
    )
    AND (
        p_cursor_created_at IS NULL
        OR (p.created_at, p.id) < (p_cursor_created_at, p_cursor_id)
    )
    ORDER BY
        CASE WHEN v_ts_query IS NOT NULL THEN ts_rank(p.search_vector, v_ts_query) ELSE 0 END DESC,
        p.created_at DESC,
        p.id DESC
    LIMIT p_limit;
END;
$$;

-- 10. updated_at auto-set trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_properties_updated_at'
    ) THEN
        CREATE TRIGGER trg_properties_updated_at
            BEFORE UPDATE ON public.properties
            FOR EACH ROW
            EXECUTE FUNCTION public.set_updated_at();
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_profiles_updated_at'
    ) THEN
        CREATE TRIGGER trg_profiles_updated_at
            BEFORE UPDATE ON public.profiles
            FOR EACH ROW
            EXECUTE FUNCTION public.set_updated_at();
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_projects_updated_at'
    ) THEN
        CREATE TRIGGER trg_projects_updated_at
            BEFORE UPDATE ON public.projects
            FOR EACH ROW
            EXECUTE FUNCTION public.set_updated_at();
    END IF;
END;
$$;

-- 11. Platform settings table for white-label branding
CREATE TABLE IF NOT EXISTS public.platform_settings (
    id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    company_name text NOT NULL DEFAULT 'Real Estate Platform',
    primary_color text NOT NULL DEFAULT '#3B82F6',
    secondary_color text NOT NULL DEFAULT '#1E293B',
    accent_color text NOT NULL DEFAULT '#F59E0B',
    logo_url text,
    logo_dark_url text,
    favicon_url text,
    contact_email text,
    contact_phone text,
    meta_title text,
    meta_description text,
    footer_text text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Insert default row if not exists
INSERT INTO public.platform_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- updated_at trigger for platform_settings
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_platform_settings_updated_at'
    ) THEN
        CREATE TRIGGER trg_platform_settings_updated_at
            BEFORE UPDATE ON public.platform_settings
            FOR EACH ROW
            EXECUTE FUNCTION public.set_updated_at();
    END IF;
END;
$$;

-- RLS: public read, admin write
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read access to platform settings" ON public.platform_settings;
CREATE POLICY "Allow public read access to platform settings"
ON public.platform_settings FOR SELECT
USING (true);

DROP POLICY IF EXISTS "Allow admins to update platform settings" ON public.platform_settings;
CREATE POLICY "Allow admins to update platform settings"
ON public.platform_settings FOR UPDATE
USING (
    (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 1
)
WITH CHECK (
    (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 1
);

DROP POLICY IF EXISTS "Allow admins to insert platform settings" ON public.platform_settings;
CREATE POLICY "Allow admins to insert platform settings"
ON public.platform_settings FOR INSERT
WITH CHECK (
    (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 1
);

-- 12. Fix event_logs RLS: scope SELECT to own logs
ALTER TABLE public.event_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated users to read event logs" ON public.event_logs;
CREATE POLICY "Allow users to read their own event logs"
ON public.event_logs FOR SELECT
USING (
    auth.uid() = user_id
    OR (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 1
);

DROP POLICY IF EXISTS "Allow authenticated users to insert event logs" ON public.event_logs;
CREATE POLICY "Allow users to insert their own event logs"
ON public.event_logs FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- 13. Fix: Add RLS to unprotected tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public read access to profiles" ON public.profiles;
CREATE POLICY "Allow public read access to profiles"
ON public.profiles FOR SELECT
USING (true);

DROP POLICY IF EXISTS "Allow users to update their own profile" ON public.profiles;
CREATE POLICY "Allow users to update their own profile"
ON public.profiles FOR UPDATE
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- 14. properties INSERT policy (was missing)
DROP POLICY IF EXISTS "Allow authenticated users to insert properties" ON public.properties;
CREATE POLICY "Allow authenticated users to insert properties"
ON public.properties FOR INSERT
WITH CHECK (auth.uid() = user_id);
