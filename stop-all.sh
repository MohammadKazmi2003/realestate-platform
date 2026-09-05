#!/usr/bin/env bash
# ============================================================
# Real Estate Platform — Stop Everything
# ============================================================
set -e

cd "$(dirname "$0")"

echo "Stopping all services..."

# 0. Stop background worker (if started via start-all.sh)
if [ -f .worker.pid ]; then
  echo "  Stopping worker (pid $(cat .worker.pid))..."
  kill "$(cat .worker.pid)" 2>/dev/null || echo "  (worker not running)"
  rm -f .worker.pid
fi

# 1. Stop docker compose services (ES, Redis)
echo "  Stopping docker compose services..."
docker compose down 2>/dev/null || echo "  (no compose services running)"

# 2. Stop Supabase (if running) — do this FIRST to free ports for next start
if supabase status 2>/dev/null | grep -q "Local URL"; then
  echo "  Stopping Supabase..."
  supabase stop
  echo "  Supabase stopped"
fi

echo "All services stopped."
