#!/usr/bin/env bash
# ============================================================
# Real Estate Platform — Stop Everything
# ============================================================
set -e

cd "$(dirname "$0")/.."

echo "Stopping all services..."

# 1. Stop docker compose services (ES, Kibana, Redis, ClickHouse)
docker compose down

# 2. Stop Supabase (if running)
if supabase status 2>/dev/null | grep -q "Local URL"; then
  supabase stop
  echo "  Supabase stopped"
fi

echo "All services stopped."
