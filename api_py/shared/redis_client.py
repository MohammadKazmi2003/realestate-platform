"""
Shared Redis client for caching.
Provides async cache operations compatible with the Search API cache format.
"""

import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_redis = None


async def get_redis():
    """Get or create the async Redis client singleton."""
    global _redis
    if _redis is None:
        import redis.asyncio as aioredis
        from api_py.shared.config import config

        _redis = aioredis.from_url(config.REDIS_URL, decode_responses=True)
        logger.info(f"Redis client initialized: {config.REDIS_URL}")
    return _redis


async def cache_get(key: str) -> Optional[Any]:
    """
    Get a value from Redis cache.

    Args:
        key: The cache key.

    Returns:
        Cached value (deserialized from JSON), or None on miss/error.
    """
    try:
        r = await get_redis()
        data = await r.get(key)
        return json.loads(data) if data else None
    except Exception:
        return None


async def cache_set(key: str, value: Any, ttl: int = 60) -> None:
    """
    Set a value in Redis cache.

    Args:
        key: The cache key.
        value: The value to cache (will be JSON-serialized).
        ttl: Time to live in seconds.
    """
    try:
        r = await get_redis()
        await r.set(key, json.dumps(value, default=str), ex=ttl)
    except Exception:
        pass


async def cache_delete(key: str) -> None:
    """Delete a key from Redis cache."""
    try:
        r = await get_redis()
        await r.delete(key)
    except Exception:
        pass
