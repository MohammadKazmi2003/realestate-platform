"""
Property search service.
Encapsulates all property search business logic (structured, text, semantic).
Delegates data access to Elasticsearch with Supabase RPC fallback.
"""

import asyncio
import json
import logging
from typing import Any, Optional

from pydantic import BaseModel, field_validator

from api_py.data.elasticsearch_client import es_search
from api_py.data.embedding_engine import embed_query
from api_py.shared.cache import TTLCache
from api_py.shared.config import config
from api_py.shared.redis_client import cache_get, cache_set

logger = logging.getLogger(__name__)

# --- Service-level caches (in-memory fallback) ---
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
        # Map user terms to actual ES property_type values
        type_map = {
            "apartment": "Residential Apartment",
            "flat": "Residential Apartment",
            "condo": "Residential Apartment",
            "studio": "Residential Apartment",
            "villa": "Independent House/Villa",
            "house": "Independent House/Villa",
            "home": "Independent House/Villa",
            "bungalow": "Independent House/Villa",
            "penthouse": "Residential Apartment",
            "plot": "Land / Plot",
            "land": "Land / Plot",
            "commercial": "Commercial",
            "office": "Commercial",
            "residential": "Residential",
        }
        for key, es_value in type_map.items():
            if key in v_lower:
                return es_value
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


class PropertySearchService:
    """Handles all property search operations via Elasticsearch."""

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
        import json
        cache_key = f"s:{json.dumps(params.model_dump(), sort_keys=True, default=str)}"

        # Try Redis first, then in-memory
        cached = await cache_get(cache_key)
        if cached is not None:
            logger.info("structured_search Redis cache HIT")
            return cached
        cached = _search_cache.get(cache_key)
        if cached is not None:
            logger.info("structured_search in-memory cache HIT")
            return cached

        must = []
        filters = [{"term": {"status": "available"}}]

        if params.location:
            must.append({
                "bool": {
                    "should": [
                        {"multi_match": {
                            "query": params.location,
                            "fields": ["location_text^3", "title^2"],
                            "fuzziness": "AUTO",
                        }},
                        {"term": {"city": params.location}},
                    ],
                    "minimum_should_match": 1,
                }
            })
        if params.property_type:
            filters.append({
                "bool": {
                    "should": [
                        {"term": {"property_type": params.property_type}},
                        {"bool": {"must_not": {"exists": {"field": "property_type"}}}},
                    ],
                    "minimum_should_match": 1,
                }
            })
        if params.min_price is not None or params.max_price is not None:
            price_range: dict[str, Any] = {}
            if params.min_price is not None:
                price_range["gte"] = params.min_price
            if params.max_price is not None:
                price_range["lte"] = params.max_price
            filters.append({
                "bool": {
                    "should": [
                        {"range": {"price": price_range}},
                        {"range": {"low_price": price_range}},
                    ],
                    "minimum_should_match": 1,
                }
            })
        if params.bedrooms is not None:
            filters.append({"term": {"bedrooms": params.bedrooms}})

        body = {
            "query": {"bool": {"must": must, "filter": filters}},
            "sort": ["_score", {"_doc": "asc"}],
            "from": (params.page - 1) * params.limit,
        }

        try:
            result = await es_search("properties_search,projects_search", body, size=params.limit)
            hits = result["hits"]["hits"]
            data = [hit["_source"] | {"id": hit["_id"]} for hit in hits]
            if data:
                await cache_set(cache_key, data, ttl=60)
                _search_cache.set(cache_key, data)
            return data
        except Exception as e:
            logger.error(f"structured_search ES error: {e}")
            return []

    async def text_search(self, query: str) -> list[dict[str, Any]]:
        """
        Search properties by name using full-text search.

        Args:
            query: The property or project name to search for.

        Returns:
            List of matching property dicts.
        """
        cache_key = f"s:{json.dumps({'query': query, 'type': 'text'}, sort_keys=True)}"

        cached = await cache_get(cache_key)
        if cached is not None:
            logger.info(f"text_search Redis cache HIT for '{query}'")
            return cached
        cached = _search_cache.get(cache_key)
        if cached is not None:
            logger.info(f"text_search in-memory cache HIT for '{query}'")
            return cached

        body = {
            "query": {
                "multi_match": {
                    "query": query,
                    "fields": ["title^3", "project_name^3", "description", "location_text^2"],
                    "fuzziness": "AUTO",
                }
            },
        }

        try:
            result = await es_search("properties_search,projects_search", body, size=10)
            hits = result["hits"]["hits"]
            data = [hit["_source"] | {"id": hit["_id"]} for hit in hits]
            if data:
                await cache_set(cache_key, data, ttl=60)
                _search_cache.set(cache_key, data)
            return data
        except Exception as e:
            logger.error(f"text_search ES error: {e}")
            return []

    async def semantic_search(self, query: str) -> list[dict[str, Any]]:
        """
        Search properties using natural language descriptions via vector similarity.
        Uses ES kNN as primary, Supabase RPC as fallback.

        Args:
            query: A descriptive or conceptual query.

        Returns:
            List of matching property dicts.
        """
        try:
            query_embedding = await _embed_query_async(query)
        except Exception as e:
            logger.error(f"Embedding generation failed: {e}")
            return []

        # Tier 1: ES kNN on both indices
        try:
            body = {
                "knn": {
                    "field": "description_embedding",
                    "query_vector": query_embedding,
                    "k": 10,
                    "num_candidates": 100,
                    "filter": {"term": {"status": "available"}},
                },
                "_source": {"excludes": ["description_embedding", "suggest", "detail_media"]},
            }
            result = await es_search("projects_search,properties_search", body, size=5)
            hits = result["hits"]["hits"]
            if hits:
                return [
                    hit["_source"] | {"id": hit["_id"], "similarity": hit["_score"]}
                    for hit in hits
                ]
        except Exception as e:
            logger.warning(f"ES kNN search failed, falling back to Supabase: {e}")

        # Tier 2: Supabase RPC fallback
        try:
            from api_py.data.supabase_client import rpc_call, table_query

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
            logger.error(f"Semantic search RPC fallback failed: {e}")
            return []

    async def search_projects(self, query: str) -> list[dict[str, Any]]:
        """
        Search for real estate projects by name.

        Args:
            query: The project name to search for.

        Returns:
            List of matching project dicts.
        """
        cache_key = f"s:{json.dumps({'query': query, 'type': 'project'}, sort_keys=True)}"

        cached = await cache_get(cache_key)
        if cached is not None:
            return cached
        cached = _search_cache.get(cache_key)
        if cached is not None:
            return cached

        body = {
            "query": {
                "multi_match": {
                    "query": query,
                    "fields": ["name^3", "description", "developer_name^2", "location_text^2"],
                    "fuzziness": "AUTO",
                }
            },
        }

        try:
            result = await es_search("projects_search", body, size=10)
            hits = result["hits"]["hits"]
            data = [hit["_source"] | {"id": hit["_id"]} for hit in hits]
            if data:
                await cache_set(cache_key, data, ttl=60)
                _search_cache.set(cache_key, data)
            return data
        except Exception as e:
            logger.error(f"search_projects ES error: {e}")
            return []


async def _embed_query_async(text: str) -> list[float]:
    """Run embedding in a thread to avoid blocking the event loop."""
    return await asyncio.to_thread(embed_query, text)
