#!/usr/bin/env bash
# ============================================================
# Real Estate Platform — Start Everything
#
# Usage: ./start-all.sh [--with-supabase]
#   Default: starts ES, Kibana(off), Redis, ClickHouse only
#   --with-supabase: also starts Supabase (12 containers) — only
#                    needed for auth/lookup development
# ============================================================
set -e

cd "$(dirname "$0")"

WITH_SUPABASE=0
for arg in "$@"; do
  case "$arg" in
    --with-supabase) WITH_SUPABASE=1 ;;
  esac
done

echo "=========================================="
echo "  Real Estate Platform — Starting All"
echo "=========================================="

# 1. Start Supabase (OPT-IN — it runs 12 containers on an 8GB machine)
if [ "$WITH_SUPABASE" = "1" ]; then
  echo ""
  echo "[1/4] Starting Supabase (CLI-managed)..."
  if ! supabase status 2>/dev/null | grep -q "Local URL"; then
    echo "  Starting Supabase (first run may take a while)..."
    if ! supabase start 2>&1; then
      echo "  ⚠ Supabase failed to start (likely port conflict from a previous run)."
      echo "  Stopping existing Supabase project and retrying..."
      supabase stop --project-id "$(grep -E '^project_id' supabase/config.toml 2>/dev/null | awk '{print $3}')" 2>/dev/null || true
      supabase start
    fi
  else
    echo "  Supabase already running"
  fi
else
  echo ""
  echo "[1/4] Skipping Supabase (use ./start-all.sh --with-supabase to include it)"
  echo "  NOTE: location lookups + auth need Supabase; map browsing does not"
fi

# 2. Start Elasticsearch + Redis + ClickHouse (docker compose; Kibana disabled)
echo ""
echo "[2/4] Starting Elasticsearch, Redis, ClickHouse..."
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
  # Use docker exec — host may not have redis-cli installed (macOS)
  if docker exec realestate-redis redis-cli ping 2>/dev/null | grep -q PONG; then
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
echo "  Supabase (opt-in)    http://localhost:54321"
echo "  Supabase Studio       http://localhost:54323"
echo "  Elasticsearch        http://localhost:9200"
echo "  Kibana               (disabled — optional)"
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
