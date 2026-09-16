-- Align fresh databases with the dev database: details_commercial.furnishing_status_id
-- exists on dev (added manually via Studio) but was never captured in a migration,
-- so fresh `supabase db reset` runs fail on any insert referencing it
-- (seed.sql demo rows + create-listing edge function commercial payloads).

ALTER TABLE public.details_commercial
ADD COLUMN IF NOT EXISTS furnishing_status_id int REFERENCES public.lookup_furnishing_statuses(id);
