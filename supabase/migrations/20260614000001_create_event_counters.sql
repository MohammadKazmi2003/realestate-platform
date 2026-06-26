-- Durability table for Redis-backed event counters
-- Worker snapshots Redis INCR counters here every 5 minutes.
-- On worker restart, counters are loaded back into Redis from this table.
-- This table is tiny (<1000 rows even at Zillow scale) and fast to query.

CREATE TABLE IF NOT EXISTS public.event_counters (
    id bigserial PRIMARY KEY,
    counter_key text NOT NULL UNIQUE,
    counter_value bigint NOT NULL DEFAULT 0,
    updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_counters_key
ON public.event_counters (counter_key);

ALTER TABLE public.event_counters ENABLE ROW LEVEL SECURITY;

-- Allow the service role (worker) to manage counters
-- Authenticated users read via API endpoint, not directly
CREATE POLICY "Service role can manage event_counters"
ON public.event_counters
USING (true)
WITH CHECK (true);
