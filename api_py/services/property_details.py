"""
Property details service.
Encapsulates business logic for fetching detailed property/project information.
Uses Elasticsearch for fast lookups with Redis caching.
"""

import logging
from typing import Any, Optional
from uuid import UUID

from api_py.data.elasticsearch_client import es_search
from api_py.shared.cache import TTLCache
from api_py.shared.config import config
from api_py.shared.redis_client import cache_get, cache_set

logger = logging.getLogger(__name__)

_detail_cache = TTLCache(ttl_seconds=config.DETAIL_CACHE_TTL)
_project_detail_cache = TTLCache(ttl_seconds=config.PROJECT_DETAIL_CACHE_TTL)


class PropertyDetailsService:
    """Handles property and project detail retrieval via Elasticsearch."""

    async def get_listing_details(self, listing_id: str) -> Optional[dict[str, Any]]:
        """
        Get full details for a single listing by UUID.
        Searches both properties and projects indices.

        Args:
            listing_id: The UUID of the property or project.

        Returns:
            Listing details dict, or None if not found.
        """
        if not listing_id:
            logger.warning("get_listing_details called with empty listing_id")
            return None

        try:
            UUID(listing_id)
        except (ValueError, TypeError):
            logger.error(f"Invalid UUID: {listing_id}")
            return None

        cache_key = f"property:{listing_id}"

        # Try Redis first, then in-memory
        cached = await cache_get(cache_key)
        if cached is not None:
            logger.info(f"get_listing_details Redis cache HIT for {listing_id}")
            return cached
        cached = _detail_cache.get(listing_id)
        if cached is not None:
            logger.info(f"get_listing_details in-memory cache HIT for {listing_id}")
            return cached

        try:
            body = {
                "query": {"ids": {"values": [listing_id]}},
            }
            result = await es_search("properties_search,projects_search", body, size=1)
            hits = result["hits"]["hits"]

            if not hits:
                return None

            details = hits[0]["_source"]
            details["id"] = hits[0]["_id"]
            await cache_set(cache_key, details, ttl=300)
            _detail_cache.set(listing_id, details)
            return details

        except Exception as e:
            logger.error(f"get_listing_details error: {e}", exc_info=True)
            return None

    async def get_project_details(self, slug: str) -> Optional[dict[str, Any]]:
        """
        Get full details for a project by URL slug.

        Args:
            slug: The URL slug of the project.

        Returns:
            Project details dict, or None if not found.
        """
        if not slug:
            logger.warning("get_project_details called with empty slug")
            return None

        cache_key = f"project:{slug}"

        cached = await cache_get(cache_key)
        if cached is not None:
            logger.info(f"get_project_details Redis cache HIT for '{slug}'")
            return cached
        cached = _project_detail_cache.get(slug)
        if cached is not None:
            logger.info(f"get_project_details in-memory cache HIT for '{slug}'")
            return cached

        try:
            body = {
                "query": {"term": {"slug": slug}},
            }
            result = await es_search("projects_search", body, size=1)
            hits = result["hits"]["hits"]

            if not hits:
                return None

            details = hits[0]["_source"]
            details["id"] = hits[0]["_id"]
            await cache_set(cache_key, details, ttl=300)
            _project_detail_cache.set(slug, details)
            return details

        except Exception as e:
            logger.error(f"get_project_details error: {e}", exc_info=True)
            return None
