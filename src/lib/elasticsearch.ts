import { Client } from '@elastic/elasticsearch';

let esClient: Client | null = null;
let esAvailable = true;
let lastHealthCheck = 0;
const HEALTH_CHECK_TTL = 10000;

// --- Circuit breaker ---
let circuitState: 'closed' | 'open' | 'half-open' = 'closed';
let circuitFailures = 0;
let circuitLastFailure = 0;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN = 30000;

function isCircuitOpen(): boolean {
  if (circuitState === 'open' && Date.now() - circuitLastFailure > CIRCUIT_COOLDOWN) {
    circuitState = 'half-open';
  }
  return circuitState === 'open';
}

export function recordEsSuccess() {
  circuitState = 'closed';
  circuitFailures = 0;
}

export function recordEsFailure() {
  circuitFailures++;
  circuitLastFailure = Date.now();
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitState = 'open';
    esAvailable = false;
  }
}

export function getElasticsearchClient(): Client {
  if (esClient) return esClient;

  // Scale-ready: comma-separated ELASTICSEARCH_URLS (or ELASTICSEARCH_URL)
  // lets you add nodes/replicas with env only — no code change. Single-node
  // default preserves local dev. Sniffing + pool tuning via env.
  const rawNodes =
    process.env.ELASTICSEARCH_URLS || process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
  const nodes = rawNodes
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const node = nodes.length > 1 ? nodes : nodes[0];
  const apiKey = process.env.ELASTICSEARCH_API_KEY;
  const sniffOnStart = ['1', 'true', 'on', 'yes'].includes(
    String(process.env.ES_SNIFF_ON_START || '').toLowerCase()
  );
  const reqTimeout = Number(process.env.ES_REQUEST_TIMEOUT_MS);
  const maxRetries = Number(process.env.ES_MAX_RETRIES);

  esClient = new Client({
    nodes: nodes.length > 1 ? nodes : undefined,
    node: nodes.length > 1 ? undefined : (node as string),
    ...(apiKey ? { auth: { apiKey } } : {}),
    maxRetries: Number.isFinite(maxRetries) ? maxRetries : 3,
    requestTimeout: Number.isFinite(reqTimeout) ? reqTimeout : 5000,
    sniffOnStart,
    // @elastic/elasticsearch 8.19 removed the nested `connectionPool` options
    // object; pool tuning is now top-level (defaults already ping/resurrect).
    resurrectStrategy: 'ping',
  });

  return esClient;
}

export async function isEsAvailable(): Promise<boolean> {
  if (isCircuitOpen()) {
    esAvailable = false;
    return false;
  }

  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_TTL) return esAvailable;

  try {
    const es = getElasticsearchClient();
    await es.ping();
    esAvailable = true;
    recordEsSuccess();
  } catch {
    esAvailable = false;
    recordEsFailure();
  }
  lastHealthCheck = now;
  return esAvailable;
}

export const ES_INDEX_ALIAS = 'properties_search';
export const ES_WRITE_ALIAS = 'properties_write';
export const PROJECTS_INDEX_ALIAS = 'projects_search';
