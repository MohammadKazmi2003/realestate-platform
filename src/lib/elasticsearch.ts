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

  const node = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
  const apiKey = process.env.ELASTICSEARCH_API_KEY;

  esClient = new Client({
    node,
    ...(apiKey ? { auth: { apiKey } } : {}),
    maxRetries: 3,
    requestTimeout: 5000,
    sniffOnStart: false,
    connectionPool: {
      pingInterval: 60000,
      resurrectStrategy: 'ping',
    },
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
