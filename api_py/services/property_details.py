"""
Property details service.
Encapsulates business logic for fetching detailed property/project information.
"""

import logging
from typing import Any, Optional
from uuid import UUID

from api_py.data.supabase_client import rpc_call
from api_py.shared.cache import TTLCache
from api_py.shared.config import config

logger = logging.getLogger(__name__)

_detail_cache = TTLCache(ttl_seconds=config.DETAIL_CACHE_TTL)
_project_detail_cache = TTLCache(ttl_seconds=config.PROJECT_DETAIL_CACHE_TTL)


class PropertyDetailsService:
    """Handles property and project detail retrieval."""

    async def get_listing_details(self, listing_id: str) -> Optional[dict[str, Any]]:
        """
        Get full details for a single property by UUID.

        Args:
            listing_id: The UUID of the property.

        Returns:
            Property details dict, or None if not found.
        """
        if not listing_id:
            logger.warning("get_listing_details called with empty listing_id")
            return None

        try:
            UUID(listing_id)
        except (ValueError, TypeError):
            logger.error(f"Invalid UUID: {listing_id}")
            return None

        cached = _detail_cache.get(listing_id)
        if cached is not None:
            logger.info(f"get_listing_details cache HIT for {listing_id}")
            return cached

        try:
            data = await rpc_call(
                "get_listing_details", {"p_listing_id": listing_id}
            )
            if not data:
                return None

            details = data[0] if isinstance(data, list) else data
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

        cached = _project_detail_cache.get(slug)
        if cached is not None:
            logger.info(f"get_project_details cache HIT for '{slug}'")
            return cached

        try:
            data = await rpc_call("get_project_by_slug", {"p_slug": slug})
            if not data:
                return None

            details = data[0] if isinstance(data, list) else data
            _project_detail_cache.set(slug, details)
            return details

        except Exception as e:
            logger.error(f"get_project_details error: {e}", exc_info=True)
            return None
