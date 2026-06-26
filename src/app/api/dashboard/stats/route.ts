import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/serverClient';
import { getOwnerViews, getOwnerClicks } from '@/lib/counters';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = user.id;

    // Postgres RPC for transactional counts (properties, leads)
    // These are OLTP queries, not event data — Postgres is correct here
    const { data: pgStats } = await supabase
      .rpc('get_property_owner_dashboard_stats', { p_user_id: userId })
      .single();

    const [views, clicks] = await Promise.all([
      getOwnerViews(userId),
      getOwnerClicks(userId),
    ]);

    return NextResponse.json({
      total_my_listings: pgStats?.total_my_listings || 0,
      total_leads_on_my_properties: pgStats?.total_leads_on_my_properties || 0,
      total_property_views: views,
      total_whatsapp_interactions: clicks,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Dashboard stats error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
