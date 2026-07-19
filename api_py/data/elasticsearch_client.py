"""
Async Elasticsearch client for the MCP agent.
Provides search, get, and health check operations.
"""

import logging
from typing import Any, Optional

from elasticsearch import AsyncElasticsearch

from api_py.shared.config import config

logger = logging.getLogger(__name__)

_client: Optional[AsyncElasticsearch] = None


async def get_es_client() -> AsyncElasticsearch:
    """Get or create the async ES client singleton."""
    global _client
    if _client is None:
        _client = AsyncElasticsearch(
            config.ELASTICSEARCH_URL,
            max_retries=3,
            request_timeout=5,
        )
        logger.info(f"Elasticsearch client initialized: {config.ELASTICSEARCH_URL}")
    return _client


async def es_search(
    index: str,
    body: dict[str, Any],
    size: int = 10,
) -> dict[str, Any]:
    """
    Execute an ES search query.

    Args:
        index: Index name(s), comma-separated for multi-index.
        body: The ES query body.
        size: Number of results to return.

    Returns:
        ES search response dict.
    """
    client = await get_es_client()
    return await client.search(index=index, body=body, size=size)


async def es_get(index: str, id: str) -> dict[str, Any]:
    """
    Get a single document by ID.

    Args:
        index: Index name.
        id: Document ID.

    Returns:
        ES get response dict with _source and _id.
    """
    client = await get_es_client()
    return await client.get(index=index, id=id)


async def es_ping() -> bool:
    """Check if Elasticsearch is reachable."""
    try:
        client = await get_es_client()
        return await client.ping(request_timeout=3)
    except Exception:
        return False
