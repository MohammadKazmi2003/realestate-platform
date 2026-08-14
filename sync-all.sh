#!/usr/bin/env bash
# ============================================================
# Real Estate Platform — Sync All Data to ES + ClickHouse
# ============================================================
set -e

cd "$(dirname "$0")"

echo "Syncing data to Elasticsearch and ClickHouse..."

echo "[1/3] Syncing properties to Elasticsearch..."
node scripts/es-indexer.js full-sync

echo "[2/3] Syncing projects to Elasticsearch..."
node scripts/es-project-indexer.js full-sync

echo "[3/3] Syncing to ClickHouse..."
node scripts/sync-to-clickhouse.js

echo ""
echo "✓ Data sync complete."
