-- Search analytics table for Zillow-scale logging of search patterns
-- Stores anonymized search data for trend analysis, popular searches, and performance monitoring
-- This table is append-only and designed for batch inserts

CREATE TABLE IF NOT EXISTS public.search_analytics (
    id bigserial PRIMARY KEY,
    session_id text,
    query_text text NOT NULL,
    total_results int DEFAULT 0,
    latency_ms int DEFAULT 0,
    filters jsonb DEFAULT '{}',
    result_count int DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

-- Index for time-range queries (most common analytics query)
CREATE INDEX IF NOT EXISTS idx_search_analytics_created_at
ON public.search_analytics (created_at DESC);

-- Index for popular search terms (used for autocomplete trends)
CREATE INDEX IF NOT EXISTS idx_search_analytics_query_text
ON public.search_analytics (query_text)
WHERE query_text IS NOT NULL AND query_text != '';

-- Enable RLS but allow inserts from authenticated and anonymous users
ALTER TABLE public.search_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow insert search analytics"
ON public.search_analytics FOR INSERT
TO authenticated, anon
WITH CHECK (true);

CREATE POLICY "Allow select search analytics for admins"
ON public.search_analytics FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.profiles
        WHERE profiles.id = auth.uid() AND profiles.role_id = 1
    )
);
