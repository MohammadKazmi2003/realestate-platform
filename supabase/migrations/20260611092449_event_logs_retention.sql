-- Event logs retention and performance
-- Adds index for time-based queries and a cleanup function

CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp
ON public.event_logs (timestamp DESC);

-- Purge event logs older than the specified days
CREATE OR REPLACE FUNCTION public.purge_old_event_logs(retention_days int DEFAULT 90)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count bigint;
BEGIN
    DELETE FROM public.event_logs
    WHERE "timestamp" < now() - (retention_days || ' days')::interval;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Record last purge timestamp for observability
CREATE TABLE IF NOT EXISTS public.maintenance_log (
    id bigserial PRIMARY KEY,
    job text NOT NULL,
    rows_affected bigint DEFAULT 0,
    started_at timestamptz DEFAULT now(),
    completed_at timestamptz DEFAULT now()
);
