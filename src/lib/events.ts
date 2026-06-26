import { queues, isQueueAvailable } from './queue';

interface ActionPayload {
  action: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  metadata?: Record<string, unknown>;
}

let queueEnabled: boolean | null = null;
let lastQueueCheck = 0;
const QUEUE_CHECK_TTL = 30_000;

async function isQueueEnabled(): Promise<boolean> {
  const now = Date.now();
  if (queueEnabled !== null && now - lastQueueCheck < QUEUE_CHECK_TTL) {
    return queueEnabled;
  }
  queueEnabled = await isQueueAvailable();
  lastQueueCheck = now;
  return queueEnabled;
}

let processingQueues = false;

async function triggerQueueProcessing(): Promise<void> {
  if (processingQueues) return;
  processingQueues = true;
  try {
    const { processAllQueues } = await import('./queueProcessor');
    for (let i = 0; i < 5; i++) {
      const result = await processAllQueues(50);
      if (result.events_processed === 0 && result.analytics_processed === 0) break;
    }
  } catch {
    // non-critical
  } finally {
    processingQueues = false;
  }
}

export async function enqueueAction(action: ActionPayload): Promise<void> {
  if (await isQueueEnabled()) {
    await queues.events.add('log_action', action, { priority: 2 });
    triggerQueueProcessing();
  } else {
    const { createSupabaseServerClient } = await import('./supabase/serverClient');
    const supabase = await createSupabaseServerClient();
    await supabase.rpc('log_action', {
      p_action: action.action,
      p_entity_type: action.entity_type,
      p_entity_id: action.entity_id,
      p_metadata: action.metadata || null,
    });
  }
}

export async function enqueueAnalytics(event: {
  query_text: string;
  total_results: number;
  latency_ms: number;
  filters?: Record<string, unknown>;
  session_id?: string;
}): Promise<void> {
  if (await isQueueEnabled()) {
    await queues.analytics.add('search_analytics', event, { priority: 3 });
    triggerQueueProcessing();
  } else {
    const { createSupabaseServerClient } = await import('./supabase/serverClient');
    const supabase = await createSupabaseServerClient();
    await supabase.from('search_analytics').insert({
      session_id: event.session_id || null,
      query_text: event.query_text,
      total_results: event.total_results,
      latency_ms: event.latency_ms,
      filters: event.filters || {},
      result_count: event.total_results,
    });
  }
}
