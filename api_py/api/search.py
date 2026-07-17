"""
Legacy search endpoint.
Backward-compatible POST /api/search for direct (non-agent) property search.
"""

import re
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api_py.data.supabase_client import rpc_call, table_query
from api_py.data.embedding_engine import embed_query

logger = logging.getLogger(__name__)

router = APIRouter()


class SearchRequest(BaseModel):
    query: str
    exclude_ids: list[str] = []


class SearchResponse(BaseModel):
    properties: list[dict[str, Any]]
    new_exclude_ids: list[str]


def _parse_query_for_filters(query: str) -> dict[str, Any]:
    """Parse natural language query into structured filters."""
    filters = {}
    query_lower = query.lower()

    location_match = re.search(r"in\s+([a-z\s]+)", query_lower)
    if location_match:
        filters["p_location"] = location_match.group(1).strip()

    bedroom_match = re.search(r"(\d+)\s*bhk|(\d+)\s*bed", query_lower)
    if bedroom_match:
        filters["p_bedrooms"] = int(bedroom_match.group(1) or bedroom_match.group(2))

    price_match = re.search(r"(under|below|less than)\s*(\d+)", query_lower)
    if price_match:
        filters["p_max_price"] = float(price_match.group(2))

    if "villa" in query_lower:
        filters["p_property_type"] = "villa"
    elif "apartment" in query_lower:
        filters["p_property_type"] = "apartment"

    return filters


@router.post("/api/search", response_model=SearchResponse)
async def search(request: SearchRequest):
    """
    Handles initial, high-speed property searches without involving an LLM.
    Backward-compatible with the legacy /api/search endpoint.
    """
    logger.info(f"Received search request with query: '{request.query}'")

    filters = _parse_query_for_filters(request.query)
    filters["p_exclude_ids"] = request.exclude_ids

    try:
        data = await rpc_call("search_all_properties", filters)

        if data:
            logger.info(f"Structured search found {len(data)} properties.")
            new_ids = [p["id"] for p in data]
            return SearchResponse(
                properties=data,
                new_exclude_ids=list(set(request.exclude_ids + new_ids)),
            )
    except Exception as e:
        logger.error(f"Error during structured search: {e}")

    # Fallback to semantic search
    logger.info("Falling back to semantic search.")
    try:
        import asyncio
        embedding = await asyncio.to_thread(embed_query, request.query)

        matches = await rpc_call(
            "match_property_chunks",
            {
                "query_embedding": embedding,
                "match_threshold": 0.75,
                "match_count": 10,
            },
        )

        if not matches:
            logger.warning("All search strategies failed.")
            return SearchResponse(properties=[], new_exclude_ids=request.exclude_ids)

        property_ids = list(
            dict.fromkeys(
                item["id"]
                for item in matches
                if item.get("id") and item["id"] not in request.exclude_ids
            )
        )

        if not property_ids:
            return SearchResponse(properties=[], new_exclude_ids=request.exclude_ids)

        final_properties = await table_query(
            "unified_listings_view",
            filters={"id": property_ids},
            limit=5,
        )

        logger.info(f"Semantic search found {len(final_properties)} properties.")
        new_ids = [p["id"] for p in final_properties]
        return SearchResponse(
            properties=final_properties,
            new_exclude_ids=list(set(request.exclude_ids + new_ids)),
        )

    except Exception as e:
        logger.error(f"An unexpected error occurred during semantic search: {e}")
        raise HTTPException(status_code=500, detail="An error occurred during search.")
