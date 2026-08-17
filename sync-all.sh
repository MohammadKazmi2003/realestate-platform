#!/usr/bin/env bash
# ============================================================
# Real Estate Platform — Sync All Data to Elasticsearch
# ============================================================
set -e

cd "$(dirname "$0")"

echo "Syncing data to Elasticsearch..."

echo "[1/2] Syncing properties to Elasticsearch..."
node scripts/es-indexer.js full-sync

echo "[2/2] Syncing projects to Elasticsearch..."
node scripts/es-project-indexer.js full-sync

echo ""
echo "✓ Data sync complete."