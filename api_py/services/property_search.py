"""
Property search service.
Encapsulates all property search business logic (structured, text, semantic).
Delegates data access to the data layer.
"""

import logging
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

from api_py.data.supabase_client import rpc_call, table_query
from api_py.data.embedding_engine import embed_query
from api_py.shared.cache import TTLCache
from api_py.shared.config import config

logger = logging.getLogger(__name__)

# --- Service-level caches ---
_search_cache = TTLCache(ttl_seconds=config.TEXT_SEARCH_CACHE_TTL, max_size=200)


# --- Input/Output Models ---

class StructuredSearchParams(BaseModel):
    location: Optional[str] = None
    property_type: Optional[str] = None
    min_price: Optional[float] = None
    max_price: Optional[float] = None
    bedrooms: Optional[int] = None
    page: int = 1
    limit: int = 5

    @field_validator("property_type")
    @classmethod
    def validate_property_type(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v_lower = v.lower()
        if "apartment" in v_lower:
            return "apartment"
        if "villa" in v_lower:
            return "villa"
        if "plot" in v_lower:
            return "plot"
        if "commercial" in v_lower:
            return "commercial"
        if "land" in v_lower:
            return "land"
        return v

    @field_validator("bedrooms", mode="before")
    @classmethod
    def validate_bedrooms(cls, v: Any) -> Optional[int]:
        if isinstance(v, str):
            import re
            match = re.search(r"\d+", v)
            if match:
                return int(match.group(0))
        return v


class PropertyResult(BaseModel):
    id: str
    title: Optional[str] = None
    price: Optional[float] = None
    location: Optional[str] = None
    property_type: Optional[str] = None
    bedrooms: Optional[int] = None
    listing_type: Optional[str] = None
    slug: Optional[str] = None


class PropertySearchService:
    """Handles all property search operations."""

    async def structured_search(
        self, params: StructuredSearchParams
    ) -> list[dict[str, Any]]:
        """
        Search properties using structured filters (location, type, price, bedrooms).

        Args:
            params: Structured search parameters.

        Returns:
            List of matching property dicts.
        """
        cache_key = f"structured:{params.model_dump_json()}"
        cached = _search_cache.get(cache_key)
        if cached is not None:
            logger.info(f"structured_search cache HIT")
            return cached

        rpc_params = {
            "p_location": params.location,
            "p_property_type": params.property_type,
            "p_min_price": params.min_price,
            "p_max_price": params.max_price,
            "p_bedrooms": params.bedrooms,
            "p_amenities": None,
            "p_exclude_ids": [],
            "p_page": params.page,
            "p_limit": params.limit,
        }
        # Remove None values
        rpc_params = {k: v for k, v in rpc_params.items() if v is not None}

        try:
            data = await rpc_call("search_all_properties", rpc_params)
            if data:
                _search_cache.set(cache_key, data)
            return data or []
        except Exception as e:
            logger.error(f"structured_search error: {e}")
            return []

    async def text_search(self, query: str) -> list[dict[str, Any]]:
        """
        Search properties by name using full-text search.

        Args:
            query: The property or project name to search for.

        Returns:
            List of matching property dicts.
        """
        cache_key = f"text:{query}"
        cached = _search_cache.get(cache_key)
        if cached is not None:
            logger.info(f"text_search cache HIT for '{query}'")
            return cached

        try:
            data = await rpc_call(
                "text_search_properties",
                {"p_query": query, "p_exclude_ids": []},
            )
            if data:
                _search_cache.set(cache_key, data)
            return data or []
        except Exception as e:
            logger.error(f"text_search error: {e}")
            return []

    async def semantic_search(self, query: str) -> list[dict[str, Any]]:
        """
        Search properties using natural language descriptions via vector similarity.

        Args:
            query: A descriptive or conceptual query.

        Returns:
            List of matching property dicts.
        """
        try:
            query_embedding = await _embed_query_async(query)

            matches = await rpc_call(
                "match_property_chunks",
                {
                    "query_embedding": query_embedding,
                    "match_threshold": 0.10,
                    "match_count": 10,
                },
            )

            if not matches:
                return []

            property_ids = list(
                dict.fromkeys(item["id"] for item in matches if item.get("id"))
            )
            if not property_ids:
                return []

            results = await table_query(
                "unified_listings_view",
                filters={"id": property_ids},
                limit=5,
            )
            return results or []

        except Exception as e:
            logger.error(f"semantic_search error: {e}", exc_info=True)
            return []

    async def search_projects(self, query: str) -> list[dict[str, Any]]:
        """
        Search for real estate projects by name.

        Args:
            query: The project name to search for.

        Returns:
            List of matching project dicts.
        """
        cache_key = f"project:{query}"
        cached = _search_cache.get(cache_key)
        if cached is not None:
            return cached

        try:
            data = await rpc_call(
                "text_search_properties",
                {"p_query": query, "p_exclude_ids": []},
            )
            if not data:
                return []

            projects = [
                item for item in data if item.get("listing_type") == "project"
            ]
            if projects:
                _search_cache.set(cache_key, projects)
            return projects or []

        except Exception as e:
            logger.error(f"search_projects error: {e}")
            return []


async def _embed_query_async(text: str) -> list[float]:
    """Run embedding in a thread to avoid blocking the event loop."""
    import asyncio

    return await asyncio.to_thread(embed_query, text)
