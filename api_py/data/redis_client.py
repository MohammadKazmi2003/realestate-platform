"""
Redis client singleton for caching.
Provides JSON-aware get/set/delete operations.
"""

import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_redis = None


def get_redis_client():
    """Return the Redis client, creating it if available."""
    global _redis
    if _redis is None:
        try:
            import redis

            _redis = redis.Redis(
                host="localhost",
                port=6379,
                decode_responses=True,
                socket_connect_timeout=2,
            )
            _redis.ping()
            logger.info("Redis client initialized.")
        except Exception as e:
            logger.warning(f"Redis not available, caching disabled: {e}")
            _redis = _FakeRedis()
    return _redis


class _FakeRedis:
    """Fallback when Redis is not available — no-ops all operations."""

    def get(self, key: str) -> None:
        return None

    def set(self, key: str, value: str, ex: Optional[int] = None) -> bool:
        return True

    def delete(self, key: str) -> int:
        return 0

    def pipeline(self):
        return self

    def execute(self) -> list:
        return []

    def incr(self, key: str) -> int:
        return 1

    def expire(self, key: str, seconds: int) -> bool:
        return True


def cache_get(key: str) -> Optional[Any]:
    """Get a cached JSON value."""
    client = get_redis_client()
    raw = client.get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw


def cache_set(key: str, value: Any, ttl_seconds: int = 60) -> bool:
    """Set a cached JSON value with TTL."""
    client = get_redis_client()
    try:
        serialized = json.dumps(value)
        client.set(key, serialized, ex=ttl_seconds)
        return True
    except Exception as e:
        logger.error(f"Redis cache_set error: {e}")
        return False


def cache_delete(key: str) -> bool:
    """Delete a cached key."""
    client = get_redis_client()
    try:
        client.delete(key)
        return True
    except Exception as e:
        logger.error(f"Redis cache_delete error: {e}")
        return False
