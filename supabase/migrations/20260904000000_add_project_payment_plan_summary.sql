-- Optional payment-plan summary for project cards (e.g. '60/40', '1% monthly').
-- Display-only: shown on cards when present, hidden when NULL. Content teams
-- fill this via Supabase Studio or admin UI; never auto-generated.
-- Structured per-milestone plans (payment_plans table) remain a follow-up.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS payment_plan_summary text;

COMMENT ON COLUMN public.projects.payment_plan_summary IS
  'Short payment-plan label for cards, e.g. 60/40 or 1% monthly. NULL hides the line.';
