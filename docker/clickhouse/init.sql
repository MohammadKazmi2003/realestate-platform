-- ClickHouse Schema for Real Estate Map Clustering
-- Materialized Views for pre-aggregated H3 clusters

-- Create database if not exists
CREATE DATABASE IF NOT EXISTS realestate;

-- ============================================================
-- 1. RAW PROPERTIES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS realestate.property_markers (
    id String,
    title String,
    lat Float64,
    lon Float64,
    price Decimal64(2),
    property_type LowCardinality(String),
    bhk_type LowCardinality(String),
    entity_type LowCardinality(String),  -- 'property' or 'project'
    status LowCardinality(String),       -- 'available', 'sold', etc.
    area_sqft Float32,
    bathrooms UInt16,
    bedrooms UInt16,
    location_text String,
    image_url String,
    created_at DateTime DEFAULT now(),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (id)
PARTITION BY toYYYYMM(created_at)
SETTINGS index_granularity = 8192;

-- ============================================================
-- 2. H3 CELL ASSIGNMENT TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS realestate.property_h3 (
    property_id String,
    h3_resolution UInt8,
    h3_index UInt64,
    lat Float64,
    lon Float64,
    price Decimal64(2),
    property_type LowCardinality(String),
    bhk_type LowCardinality(String),
    entity_type LowCardinality(String),
    status LowCardinality(String),
    area_sqft Float32,
    bedrooms UInt16,
    bathrooms UInt16,
    location_text String,
    image_url String,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (h3_resolution, h3_index, property_id)
PARTITION BY h3_resolution;

-- ============================================================
-- 3. PRE-AGGREGATED CLUSTERS (Materialized View)
-- ============================================================
CREATE TABLE IF NOT EXISTS realestate.h3_clusters_precomputed (
    h3_resolution UInt8,
    h3_index UInt64,
    property_count AggregateFunction(count, UInt8),
    project_count AggregateFunction(countIf, UInt8, UInt8),
    avg_price AggregateFunction(avg, Decimal64(2)),
    min_price AggregateFunction(min, Decimal64(2)),
    max_price AggregateFunction(max, Decimal64(2)),
    avg_area AggregateFunction(avg, Float32),
    center_lat AggregateFunction(avg, Float64),
    center_lon AggregateFunction(avg, Float64),
    total_bedrooms AggregateFunction(sum, UInt16),
    total_bathrooms AggregateFunction(sum, UInt16)
)
ENGINE = AggregatingMergeTree()
ORDER BY (h3_resolution, h3_index)
PARTITION BY h3_resolution;

-- ============================================================
-- 4. MATERIALIZED VIEWS (Auto-update on INSERT)
-- ============================================================

-- H3 Resolution 5: Region/city level (~253 km² hexagons)
CREATE MATERIALIZED VIEW IF NOT EXISTS realestate.h3_zoom5_mv
TO realestate.h3_clusters_precomputed
AS SELECT
    5 AS h3_resolution,
    geoToH3(lat, lon, 5) AS h3_index,
    countState(toUInt8(1)) AS property_count,
    countIfState(toUInt8(1), entity_type = 'project') AS project_count,
    avgState(price) AS avg_price,
    minState(price) AS min_price,
    maxState(price) AS max_price,
    avgState(area_sqft) AS avg_area,
    avgState(lat) AS center_lat,
    avgState(lon) AS center_lon,
    sumState(toUInt16(bedrooms)) AS total_bedrooms,
    sumState(toUInt16(bathrooms)) AS total_bathrooms
FROM realestate.property_markers
WHERE status = 'available'
GROUP BY h3_index;

-- H3 Resolution 7: Neighborhood level (~5 km² hexagons)
CREATE MATERIALIZED VIEW IF NOT EXISTS realestate.h3_zoom7_mv
TO realestate.h3_clusters_precomputed
AS SELECT
    7 AS h3_resolution,
    geoToH3(lat, lon, 7) AS h3_index,
    countState(toUInt8(1)) AS property_count,
    countIfState(toUInt8(1), entity_type = 'project') AS project_count,
    avgState(price) AS avg_price,
    minState(price) AS min_price,
    maxState(price) AS max_price,
    avgState(area_sqft) AS avg_area,
    avgState(lat) AS center_lat,
    avgState(lon) AS center_lon,
    sumState(toUInt16(bedrooms)) AS total_bedrooms,
    sumState(toUInt16(bathrooms)) AS total_bathrooms
FROM realestate.property_markers
WHERE status = 'available'
GROUP BY h3_index;

-- H3 Resolution 8: Block level (~0.7 km² hexagons)
CREATE MATERIALIZED VIEW IF NOT EXISTS realestate.h3_zoom8_mv
TO realestate.h3_clusters_precomputed
AS SELECT
    8 AS h3_resolution,
    geoToH3(lat, lon, 8) AS h3_index,
    countState(toUInt8(1)) AS property_count,
    countIfState(toUInt8(1), entity_type = 'project') AS project_count,
    avgState(price) AS avg_price,
    minState(price) AS min_price,
    maxState(price) AS max_price,
    avgState(area_sqft) AS avg_area,
    avgState(lat) AS center_lat,
    avgState(lon) AS center_lon,
    sumState(toUInt16(bedrooms)) AS total_bedrooms,
    sumState(toUInt16(bathrooms)) AS total_bathrooms
FROM realestate.property_markers
WHERE status = 'available'
GROUP BY h3_index;
