"""
Search API endpoint.
Rewritten to use Elasticsearch instead of Supabase RPC.
"""

import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from api_py.data.elasticsearch_client import es_search

logger = logging.getLogger(__name__)

router = APIRouter()


class SearchRequest(BaseModel):
    query: str
    exclude_ids: list[str] = []


class SearchResponse(BaseModel):
    properties: list[dict[str, Any]]
    new_exclude_ids: list[str]


@router.post("/api/search", response_model=SearchResponse)
async def search(request: SearchRequest):
    """
    Property search via Elasticsearch.
    Replaces the legacy Supabase RPC implementation.
    """
    body = {
        "query": {
            "multi_match": {
                "query": request.query,
                "fields": ["title^3", "description", "location_text^2", "project_name^2"],
                "fuzziness": "AUTO",
            }
        },
    }

    try:
        result = await es_search("properties_search,projects_search", body)
        hits = result["hits"]["hits"]
        properties = [hit["_source"] | {"id": hit["_id"]} for hit in hits]
        new_ids = [p["id"] for p in properties]
        return SearchResponse(
            properties=properties,
            new_exclude_ids=list(set(request.exclude_ids + new_ids)),
        )
    except Exception as e:
        logger.error(f"Search error: {e}")
        return SearchResponse(properties=[], new_exclude_ids=request.exclude_ids)
