import { Client } from '@elastic/elasticsearch';

let esClient: Client | null = null;

export function getElasticsearchClient(): Client {
  if (esClient) return esClient;

  const node = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
  const apiKey = process.env.ELASTICSEARCH_API_KEY;

  esClient = new Client({
    node,
    ...(apiKey ? { auth: { apiKey } } : {}),
    maxRetries: 3,
    requestTimeout: 10000,
    sniffOnStart: false,
  });

  return esClient;
}

export const ES_INDEX_ALIAS = 'properties_search';
export const ES_WRITE_ALIAS = 'properties_write';
