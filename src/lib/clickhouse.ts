import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { logger } from './logger';

let chClient: ClickHouseClient | null = null;

export function getClickHouseClient(): ClickHouseClient {
  if (!chClient) {
    chClient = createClient({
      url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
      database: process.env.CLICKHOUSE_DB || 'realestate',
      request_timeout: 2000,
      max_open_connections: 10,
    });
  }
  return chClient;
}

export function isClickHouseAvailable(): boolean {
  return !!process.env.CLICKHOUSE_URL;
}

export interface ClusterResult {
  h3_index: number;
  count: number;
  avg_price: number;
  min_price: number;
  max_price: number;
  center_lat: number;
  center_lon: number;
}

export interface MapTileResponse {
  clusters: ClusterResult[];
  total: number;
  h3_resolution: number;
}

// Maps zoom levels to H3 resolutions (must match MV resolutions in init.sql).
// Each zoom level has a dedicated H3 resolution so that cell counts per viewport
// stay roughly constant (~20-200 cells) regardless of zoom.
function zoomToH3Resolution(zoom: number): number {
  if (zoom <= 4) return 4;     // State/region (~690 km² cells)
  if (zoom <= 6) return 5;     // City (~253 km²)
  if (zoom <= 8) return 6;     // District (~80 km²)
  if (zoom <= 10) return 7;    // Neighborhood (~5 km²)
  if (zoom <= 12) return 8;    // Block (~0.7 km²)
  if (zoom <= 14) return 9;    // Street (~0.25 km²)
  return 10;                    // Building (~0.08 km²) — at zoom 15+, client-side supercluster takes over
}

// Convert price to bucket (10L increments)
function priceToBucket(price: number): number {
  return Math.floor(price / 100000);
}

// Convert price range to bucket range
function priceRangeToBuckets(minPrice?: number, maxPrice?: number): { minBucket: number; maxBucket: number } | null {
  if (minPrice == null && maxPrice == null) return null;
  const minBucket = minPrice != null ? priceToBucket(minPrice) : 0;
  const maxBucket = maxPrice != null ? priceToBucket(maxPrice) : 999;
  return { minBucket, maxBucket };
}

export async function getMapClusters(
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  zoom: number,
  filters?: {
    minPrice?: number;
    maxPrice?: number;
    propertyType?: string;
    bhkType?: string;
    entityType?: string;
    locationText?: string;
  }
): Promise<MapTileResponse> {
  const client = getClickHouseClient();
  const h3Resolution = zoomToH3Resolution(zoom);

  // Step 1: Build WHERE clause for h3_resolution only
  const conditions: string[] = [
    'h3_resolution = {h3Resolution:UInt8}',
  ];

  // Filter dimensions (from MV GROUP BY columns)
  // Property type and BHK filters: apply unconditionally.
  // Projects have empty property_type/bhk_type in the MV, so the filter naturally
  // only matches properties — no entityType guard needed.
  if (filters?.propertyType) {
    conditions.push(`property_type = {propertyType:String}`);
  }
  if (filters?.bhkType) {
    conditions.push(`bhk_type = {bhkType:String}`);
  }
  if (filters?.entityType) {
    conditions.push(`entity_type = {entityType:String}`);
  }
  // B2: Location text filter — best-effort match on location_text
  if (filters?.locationText && filters.locationText.trim().length >= 2) {
    conditions.push(`location_text ILIKE {locationText:String}`);
  }

  // Price bucket filter (UInt16 supports up to ₹65.5Cr)
  const priceBuckets = priceRangeToBuckets(filters?.minPrice, filters?.maxPrice);
  if (priceBuckets) {
    conditions.push(`price_bucket >= {minBucket:UInt16} AND price_bucket <= {maxBucket:UInt16}`);
  }

  // Query using subquery for spatial filtering (avoids HAVING on aggregate columns)
  // h3ToGeo() computes centroid from h3_index at query time
  const query = `
    SELECT
      h3_index,
      count,
      avg_price,
      min_price,
      max_price,
      h3ToGeo(h3_index).1 AS center_lat,
      h3ToGeo(h3_index).2 AS center_lon
    FROM (
      SELECT
        h3_index,
        countMerge(property_count) AS count,
        avgMerge(avg_price) AS avg_price,
        minMerge(min_price) AS min_price,
        maxMerge(max_price) AS max_price
      FROM h3_clusters_precomputed
      WHERE ${conditions.join(' AND ')}
      GROUP BY h3_index
    ) AS subquery
    WHERE center_lat >= {minLat:Float64} AND center_lat <= {maxLat:Float64}
      AND center_lon >= {minLng:Float64} AND center_lon <= {maxLng:Float64}
    ORDER BY count DESC
  `;

  const params: Record<string, any> = {
    h3Resolution,
    minLat: bounds.minLat,
    maxLat: bounds.maxLat,
    minLng: bounds.minLng,
    maxLng: bounds.maxLng,
  };

  if (filters?.propertyType) params.propertyType = filters.propertyType;
  if (filters?.bhkType) params.bhkType = filters.bhkType;
  if (filters?.entityType) params.entityType = filters.entityType;
  if (filters?.locationText && filters.locationText.trim().length >= 2) {
    params.locationText = `%${filters.locationText.trim()}%`;
  }
  if (priceBuckets) {
    params.minBucket = priceBuckets.minBucket;
    params.maxBucket = priceBuckets.maxBucket;
  }

  // Retry logic for intermittent timeouts
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resultSet = await client.query({
        query,
        format: 'JSONEachRow',
        query_params: params,
      });

      const textResult = await resultSet.text();
      const rows = textResult
        .split('\n')
        .filter((line: string) => line.trim())
        .map((line: string) => JSON.parse(line));

      // Step 3: Parse results (center_lat/center_lon are already regular Float64)
      const clusters: ClusterResult[] = rows
        .filter((r: any) => r.count > 0)
        .map((r: any) => ({
          h3_index: r.h3_index,
          count: r.count,
          avg_price: r.avg_price,
          min_price: r.min_price,
          max_price: r.max_price,
          center_lat: r.center_lat,
          center_lon: r.center_lon,
        }));

      const total = clusters.reduce((sum, c) => sum + c.count, 0);

      return {
        clusters,
        total,
        h3_resolution: h3Resolution,
      };
    } catch (error) {
      lastError = error as Error;
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  logger.error('ClickHouse query error after retries', lastError);
  throw lastError;
}

export async function insertProperty(property: {
  id: string;
  title: string;
  lat: number;
  lon: number;
  price: number;
  property_type: string;
  bhk_type: string;
  entity_type: string;
  status: string;
  area_sqft: number;
  bathrooms: number;
  bedrooms: number;
  location_text: string;
  image_url: string;
}): Promise<void> {
  const client = getClickHouseClient();
  await client.insert({
    table: 'property_markers',
    values: [property],
    format: 'JSONEachRow',
  });
}

export async function insertPropertiesBatch(properties: Array<{
  id: string;
  title: string;
  lat: number;
  lon: number;
  price: number;
  property_type: string;
  bhk_type: string;
  entity_type: string;
  status: string;
  area_sqft: number;
  bathrooms: number;
  bedrooms: number;
  location_text: string;
  image_url: string;
}>): Promise<void> {
  if (properties.length === 0) return;
  const client = getClickHouseClient();
  await client.insert({
    table: 'property_markers',
    values: properties,
    format: 'JSONEachRow',
  });
}

export async function pingClickHouse(): Promise<boolean> {
  try {
    const client = getClickHouseClient();
    const result = await client.query({
      query: 'SELECT 1',
      format: 'TabSeparatedWithNames',
    });
    await result.text();
    return true;
  } catch {
    return false;
  }
}
