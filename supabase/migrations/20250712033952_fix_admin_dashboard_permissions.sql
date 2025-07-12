-- This migration updates the admin dashboard statistics function to run with
-- the necessary permissions to read from the auth.users table.

-- By adding `SECURITY DEFINER`, the function executes with the privileges
-- of the user who created it (the database owner), which has the required access.
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_stats()
RETURNS TABLE (
    total_listings bigint,
    active_agents bigint,
    new_user_signups_24h bigint,
    total_leads bigint
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        (SELECT COUNT(*) FROM public.properties) as total_listings,
        (SELECT COUNT(*) FROM public.profiles WHERE role_id = 3) as active_agents,
        (SELECT COUNT(*) FROM auth.users WHERE created_at >= now() - interval '24 hours') as new_user_signups_24h,
        (SELECT COUNT(*) FROM public.leads) as total_leads;
END;
$$;
