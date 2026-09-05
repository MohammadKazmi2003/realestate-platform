import { NextRequest, NextResponse } from 'next/server';
import { enqueueSearchIndex } from '@/lib/searchIndex';
import { logger } from '@/lib/logger';

// Incremental indexing entry point for client-side mutation flows
// (create/delete happen in client components / edge functions that can't
// reach BullMQ directly). Enqueueing only schedules a re-read of public
// listing data, so no auth is required — payload is strictly validated.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { entity, id, op } = (body || {}) as { entity?: unknown; id?: unknown; op?: unknown };
  if (entity !== 'property' && entity !== 'project') {
    return NextResponse.json({ error: 'Invalid entity' }, { status: 400 });
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  if (op !== undefined && op !== 'upsert' && op !== 'delete') {
    return NextResponse.json({ error: 'Invalid op' }, { status: 400 });
  }
  try {
    const result = await enqueueSearchIndex({ entity, id, op });
    if (result === 'failed') {
      return NextResponse.json({ error: 'Indexing unavailable' }, { status: 503 });
    }
    return NextResponse.json({ [result]: true }, { status: 202 });
  } catch (error) {
    logger.error('search-index enqueue error', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
