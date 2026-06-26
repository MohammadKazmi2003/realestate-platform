import { NextRequest, NextResponse } from 'next/server';
import { processAllQueues } from '@/lib/queueProcessor';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const expectedToken = process.env.CRON_SECRET;

  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await processAllQueues(100);
    return NextResponse.json({
      processed: true,
      events: result.events_processed,
      analytics: result.analytics_processed,
      maintenance: result.maintenance_processed,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Queue processing error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
