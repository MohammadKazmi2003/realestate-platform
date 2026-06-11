import { Client } from '@elastic/elasticsearch';

let esClient: Client | null = null;
let esAvailable = true;
let lastHealthCheck = 0;
const HEALTH_CHECK_TTL = 30000;

export function getElasticsearchClient(): Client {
  if (esClient) return esClient;

  const node = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
  const apiKey = process.env.ELASTICSEARCH_API_KEY;

  esClient = new Client({
    node,
    ...(apiKey ? { auth: { apiKey } } : {}),
    maxRetries: 2,
    requestTimeout: 5000,
    sniffOnStart: false,
  });

  return esClient;
}

export async function isEsAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_TTL) return esAvailable;

  try {
    const es = getElasticsearchClient();
    await es.ping();
    esAvailable = true;
  } catch {
    esAvailable = false;
  }
  lastHealthCheck = now;
  return esAvailable;
}

export const ES_INDEX_ALIAS = 'properties_search';
export const ES_WRITE_ALIAS = 'properties_write';
