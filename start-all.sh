#!/usr/bin/env bash
# ============================================================
# Real Estate Platform — Start Everything
#
# Starts: Supabase (CLI-managed), Elasticsearch, Kibana,
#         Redis, ClickHouse (docker compose)
# ============================================================
set -e

cd "$(dirname "$0")/.."

echo "=========================================="
echo "  Real Estate Platform — Starting All"
echo "=========================================="

# 1. Start Supabase (manages its own ~15 containers: postgres, kong, auth, rest, storage, studio, ...)
echo ""
echo "[1/4] Starting Supabase (CLI-managed)..."
if ! supabase status 2>/dev/null | grep -q "Local URL"; then
  supabase start
else
  echo "  Supabase already running"
fi

# 2. Start Elasticsearch + Kibana + Redis + ClickHouse (docker compose)
echo ""
echo "[2/4] Starting Elasticsearch, Kibana, Redis, ClickHouse..."
docker compose up -d

# 3. Wait for services to become healthy
echo ""
echo "[3/4] Waiting for services to become healthy..."
echo "  Waiting for Elasticsearch..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:9200/ >/dev/null 2>&1; then
    echo "    ✓ Elasticsearch ready"
    break
  fi
  [ "$i" = "30" ] && echo "    ✗ Elasticsearch not ready — check 'docker compose ps'" && exit 1
  sleep 2
done

echo "  Waiting for ClickHouse..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:8123/ping >/dev/null 2>&1; then
    echo "    ✓ ClickHouse ready"
    break
  fi
  [ "$i" = "15" ] && echo "    ✗ ClickHouse not ready — check 'docker compose ps'" && exit 1
  sleep 2
done

echo "  Waiting for Redis..."
for i in $(seq 1 10); do
  if redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "    ✓ Redis ready"
    break
  fi
  [ "$i" = "10" ] && echo "    ✗ Redis not ready" && exit 1
  sleep 1
done

echo ""
echo "[4/4] All services running!"
echo "=========================================="
echo ""
echo "  Supabase (Postgres)  http://localhost:54321"
echo "  Supabase Studio       http://localhost:54323"
echo "  Elasticsearch        http://localhost:9200"
echo "  Kibana               http://localhost:5601"
echo "  Redis                redis://localhost:6379"
echo "  ClickHouse           http://localhost:8123"
echo ""
echo "  Next step — start the app:"
echo "    npm run dev   →  http://localhost:3000"
echo ""
echo "  If data is missing, sync it:"
echo "    node scripts/es-indexer.js full-sync"
echo "    node scripts/es-project-indexer.js full-sync"
echo "    node scripts/sync-to-clickhouse.js"
echo "=========================================="
