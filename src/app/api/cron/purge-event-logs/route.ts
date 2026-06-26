import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/serverClient';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const expectedToken = process.env.CRON_SECRET;
  if (!expectedToken) {
    console.error('CRON_SECRET env var not set — cron endpoint disabled');
    return NextResponse.json({ error: 'Not configured' }, { status: 500 });
  }

  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const supabase = await createSupabaseServerClient();

    // Purge event_logs older than 90 days
    const { data: deletedCount, error } = await supabase.rpc('purge_old_event_logs', {
      retention_days: 90,
    });

    if (error) {
      console.error('Purge event logs failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Log the maintenance run
    await supabase.from('maintenance_log').insert({
      job: 'purge_event_logs',
      rows_affected: deletedCount || 0,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    console.log(`Cron: Purged ${deletedCount} old event log rows`);
    return NextResponse.json({ success: true, rows_deleted: deletedCount });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Cron purge error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
