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
      request_timeout: 30000,
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
  bedrooms: number;
  bathrooms: number;
}

export interface MapTileResponse {
  clusters: ClusterResult[];
  total: number;
  h3_resolution: number;
}

function zoomToH3Resolution(zoom: number): number {
  if (zoom <= 4) return 4;
  if (zoom <= 6) return 5;
  if (zoom <= 8) return 6;
  if (zoom <= 10) return 7;
  if (zoom <= 12) return 8;
  return 9;
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
  }
): Promise<MapTileResponse> {
  const client = getClickHouseClient();
  const h3Resolution = zoomToH3Resolution(zoom);

  let whereClause = `lat >= {minLat:Float64} AND lat <= {maxLat:Float64} AND lon >= {minLng:Float64} AND lon <= {maxLng:Float64} AND status = 'available'`;

  if (filters?.minPrice) {
    whereClause += ` AND price >= {minPrice:Decimal64(2)}`;
  }
  if (filters?.maxPrice) {
    whereClause += ` AND price <= {maxPrice:Decimal64(2)}`;
  }
  if (filters?.propertyType) {
    whereClause += ` AND property_type = {propertyType:String}`;
  }
  if (filters?.bhkType) {
    whereClause += ` AND bhk_type = {bhkType:String}`;
  }
  if (filters?.entityType) {
    whereClause += ` AND entity_type = {entityType:String}`;
  }

  const query = `
    SELECT
      geoToH3(lat, lon, ${h3Resolution}) AS h3_index,
      count() AS count,
      avg(price) AS avg_price,
      min(price) AS min_price,
      max(price) AS max_price,
      avg(lat) AS center_lat,
      avg(lon) AS center_lon,
      sum(toUInt16(bedrooms)) AS bedrooms,
      sum(toUInt16(bathrooms)) AS bathrooms
    FROM property_markers
    WHERE ${whereClause}
    GROUP BY h3_index
    ORDER BY count DESC
  `;

  const params: Record<string, any> = {
    minLat: bounds.minLat,
    maxLat: bounds.maxLat,
    minLng: bounds.minLng,
    maxLng: bounds.maxLng,
  };

  if (filters?.minPrice) params.minPrice = filters.minPrice;
  if (filters?.maxPrice) params.maxPrice = filters.maxPrice;
  if (filters?.propertyType) params.propertyType = filters.propertyType;
  if (filters?.bhkType) params.bhkType = filters.bhkType;
  if (filters?.entityType) params.entityType = filters.entityType;

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
      const rows: ClusterResult[] = textResult
        .split('\n')
        .filter((line: string) => line.trim())
        .map((line: string) => JSON.parse(line));

      const total = rows.reduce((sum: number, r: ClusterResult) => sum + r.count, 0);

      return {
        clusters: rows.filter((r: ClusterResult) => r.count > 0),
        total,
        h3_resolution: h3Resolution,
      };
    } catch (error) {
      lastError = error as Error;
      if (attempt === 0) {
        // Wait 100ms before retry
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

  const resolutions = [5, 7, 8];

  const h3Rows = resolutions.map((res) => ({
    property_id: property.id,
    h3_resolution: res,
    h3_index: latLngToH3(property.lat, property.lon, res),
    lat: property.lat,
    lon: property.lon,
    price: property.price,
    property_type: property.property_type,
    bhk_type: property.bhk_type,
    entity_type: property.entity_type,
    status: property.status,
    area_sqft: property.area_sqft,
    bedrooms: property.bedrooms,
    bathrooms: property.bathrooms,
    location_text: property.location_text,
    image_url: property.image_url,
  }));

  await client.insert({
    table: 'property_markers',
    values: [property],
    format: 'JSONEachRow',
  });

  await client.insert({
    table: 'property_h3',
    values: h3Rows,
    format: 'JSONEachRow',
  });
}

function latLngToH3(lat: number, lon: number, resolution: number): number {
  const { latLngToCell } = require('h3-js');
  return parseInt(latLngToCell(lat, lon, resolution), 16);
}

function generateH3Cells(
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  resolution: number
): number[] {
  const { polygonToCells } = require('h3-js');

  const boundary = [
    [bounds.minLng, bounds.maxLat],
    [bounds.maxLng, bounds.maxLat],
    [bounds.maxLng, bounds.minLat],
    [bounds.minLng, bounds.minLat],
  ];

  return polygonToCells(boundary, resolution).map((cell: string) => parseInt(cell, 16));
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
