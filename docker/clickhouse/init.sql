-- ClickHouse Schema for Real Estate Map Clustering
-- Zillow-Scale Production Schema

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
    entity_type LowCardinality(String),
    status LowCardinality(String),
    area_sqft Float32,
    bathrooms UInt16,
    bedrooms UInt16,
    location_text String,
    image_url String,
    created_at DateTime DEFAULT now(),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (lat, lon, id)
PARTITION BY toYYYYMM(created_at)
TTL created_at + INTERVAL 5 YEAR
SETTINGS index_granularity = 8192;

-- ============================================================
-- 2. PRE-AGGREGATED CLUSTERS
-- ============================================================
-- No center_lat/center_lon stored — use h3ToGeo() at query time
-- ORDER BY (h3_resolution, h3_index, ...) for primary index
CREATE TABLE IF NOT EXISTS realestate.h3_clusters_precomputed (
    h3_resolution  UInt8,
    h3_index       UInt64,
    property_type  LowCardinality(String),
    bhk_type       LowCardinality(String),
    entity_type    LowCardinality(String),
    price_bucket   UInt16,
    property_count AggregateFunction(count, UInt8),
    avg_price      AggregateFunction(avg, Decimal64(2)),
    min_price      AggregateFunction(min, Decimal64(2)),
    max_price      AggregateFunction(max, Decimal64(2)),
    total_bedrooms AggregateFunction(sum, UInt16),
    total_bathrooms AggregateFunction(sum, UInt16)
)
ENGINE = AggregatingMergeTree()
ORDER BY (h3_resolution, h3_index, property_type, bhk_type, entity_type, price_bucket)
PARTITION BY h3_resolution;

-- ============================================================
-- 3. MATERIALIZED VIEWS (Auto-update on INSERT)
-- ============================================================

-- H3 Resolution 5
CREATE MATERIALIZED VIEW IF NOT EXISTS realestate.h3_zoom5_mv
TO realestate.h3_clusters_precomputed
AS SELECT
    5 AS h3_resolution,
    geoToH3(lat, lon, 5) AS h3_index,
    property_type, bhk_type, entity_type,
    toUInt16(toInt64(price) / 100000) AS price_bucket,
    countState(toUInt8(1)) AS property_count,
    avgState(price) AS avg_price,
    minState(price) AS min_price,
    maxState(price) AS max_price,
    sumState(toUInt16(bedrooms)) AS total_bedrooms,
    sumState(toUInt16(bathrooms)) AS total_bathrooms
FROM realestate.property_markers
WHERE status = 'available'
GROUP BY h3_index, property_type, bhk_type, entity_type, price_bucket;

-- H3 Resolution 7
CREATE MATERIALIZED VIEW IF NOT EXISTS realestate.h3_zoom7_mv
TO realestate.h3_clusters_precomputed
AS SELECT
    7 AS h3_resolution,
    geoToH3(lat, lon, 7) AS h3_index,
    property_type, bhk_type, entity_type,
    toUInt16(toInt64(price) / 100000) AS price_bucket,
    countState(toUInt8(1)) AS property_count,
    avgState(price) AS avg_price,
    minState(price) AS min_price,
    maxState(price) AS max_price,
    sumState(toUInt16(bedrooms)) AS total_bedrooms,
    sumState(toUInt16(bathrooms)) AS total_bathrooms
FROM realestate.property_markers
WHERE status = 'available'
GROUP BY h3_index, property_type, bhk_type, entity_type, price_bucket;

-- H3 Resolution 8
CREATE MATERIALIZED VIEW IF NOT EXISTS realestate.h3_zoom8_mv
TO realestate.h3_clusters_precomputed
AS SELECT
    8 AS h3_resolution,
    geoToH3(lat, lon, 8) AS h3_index,
    property_type, bhk_type, entity_type,
    toUInt16(toInt64(price) / 100000) AS price_bucket,
    countState(toUInt8(1)) AS property_count,
    avgState(price) AS avg_price,
    minState(price) AS min_price,
    maxState(price) AS max_price,
    sumState(toUInt16(bedrooms)) AS total_bedrooms,
    sumState(toUInt16(bathrooms)) AS total_bathrooms
FROM realestate.property_markers
WHERE status = 'available'
GROUP BY h3_index, property_type, bhk_type, entity_type, price_bucket;
