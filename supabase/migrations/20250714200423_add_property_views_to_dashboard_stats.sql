    -- This migration updates the property owner dashboard statistics function
    -- to include a new metric for counting total property views.

    -- First, DROP the old function if it exists to allow for a clean update
    -- of the return signature.
    DROP FUNCTION IF EXISTS public.get_property_owner_dashboard_stats(uuid);

    -- We use CREATE OR REPLACE to safely update the function.
    CREATE OR REPLACE FUNCTION public.get_property_owner_dashboard_stats(p_user_id uuid)
    RETURNS TABLE (
        total_my_listings bigint,
        total_leads_on_my_properties bigint,
        total_whatsapp_interactions bigint,
        total_property_views bigint -- This is the new column for our metric
    )
    LANGUAGE plpgsql
    AS $$
    BEGIN
        RETURN QUERY
        SELECT
            (SELECT COUNT(*) FROM public.properties WHERE user_id = p_user_id) as total_my_listings,
            (SELECT COUNT(*) FROM public.leads WHERE property_id IN (SELECT id FROM public.properties WHERE user_id = p_user_id)) as total_leads_on_my_properties,
            (SELECT COUNT(*) FROM public.event_logs WHERE event_type = 'whatsapp_click' AND property_id IN (SELECT id FROM public.properties WHERE user_id = p_user_id)) as total_whatsapp_interactions,
            -- This new subquery counts the 'property_view' events for the user's properties.
            (SELECT COUNT(*) FROM public.event_logs WHERE event_type = 'property_view' AND property_id IN (SELECT id FROM public.properties WHERE user_id = p_user_id)) as total_property_views;
    END;
    $$;
    