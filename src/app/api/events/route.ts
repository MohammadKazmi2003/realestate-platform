import { NextRequest, NextResponse } from 'next/server';
import { enqueueAction } from '@/lib/events';
import { incrView, incrClick } from '@/lib/counters';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { event_type, action, user_id, property_id, entity_type, entity_id, metadata, owner_id } = body;

    // Actions (audit trail) still go through BullMQ for retry guarantees
    if (action && entity_type && entity_id) {
      await enqueueAction({
        action,
        entity_type,
        entity_id,
        user_id: user_id || '',
        metadata: metadata || undefined,
      });
      return NextResponse.json({ queued: true });
    }

    // Analytics counters use Redis INCR — zero Postgres writes, zero queue
    if (event_type === 'property_view' && property_id && owner_id) {
      await incrView(property_id, owner_id);
      return NextResponse.json({ counted: true });
    }

    if (event_type === 'whatsapp_click' && property_id && owner_id) {
      await incrClick(property_id, owner_id);
      return NextResponse.json({ counted: true });
    }

    return NextResponse.json({ error: 'Unknown event_type' }, { status: 400 });
  } catch (err: unknown) {
    console.error('Event API error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Failed to process event' }, { status: 500 });
  }
}
