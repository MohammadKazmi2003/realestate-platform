    -- Function for Admin Dashboard Statistics
    CREATE OR REPLACE FUNCTION get_admin_dashboard_stats()
    RETURNS TABLE (
        total_listings bigint,
        active_agents bigint,
        new_user_signups_24h bigint,
        total_leads bigint
    )
    LANGUAGE plpgsql
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

    -- Function for Property Owner Dashboard Statistics
    CREATE OR REPLACE FUNCTION get_property_owner_dashboard_stats(p_user_id uuid)
    RETURNS TABLE (
        total_my_listings bigint,
        total_leads_on_my_properties bigint,
        total_whatsapp_interactions bigint
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        RETURN QUERY
        SELECT
            (SELECT COUNT(*) FROM public.properties WHERE user_id = p_user_id) as total_my_listings,
            (SELECT COUNT(*) FROM public.leads WHERE property_id IN (SELECT id FROM public.properties WHERE user_id = p_user_id)) as total_leads_on_my_properties,
            (SELECT COUNT(*) FROM public.event_logs WHERE event_type = 'whatsapp_click' AND property_id IN (SELECT id FROM public.properties WHERE user_id = p_user_id)) as total_whatsapp_interactions;
    END;
    $$;
    