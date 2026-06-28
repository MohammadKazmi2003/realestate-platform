# --- api_py/tools.py ---
"""
This file creates a standardized, well-documented interface for all database
and web search tools available to the conversational agent.

Each function is decorated with @tool and includes a Pydantic model for
typed arguments and a detailed docstring. These docstrings are the
primary instructions for the LLM, guiding it on when and how to use each tool.
"""

import os
import json
import asyncio
import logging
import time
from typing import Optional, List
from uuid import UUID
from threading import Lock

from dotenv import load_dotenv
from pydantic import BaseModel, Field
from langchain_core.tools import tool
from langchain_community.tools.tavily_search import TavilySearchResults
from supabase import create_client, Client

# --- Initialization ---
load_dotenv()
logger = logging.getLogger(__name__)

# --- Clients ---
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY")

if not all([SUPABASE_URL, SUPABASE_SERVICE_KEY, TAVILY_API_KEY]):
    raise ValueError("One or more required environment variables are missing (SUPABASE, TAVILY).")

try:
    supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
except Exception as e:
    logger.error(f"Failed to initialize Supabase client: {e}")
    raise

class _TTLCache:
    def __init__(self, ttl_seconds: int = 300, max_size: int = 500):
        self._store: dict[str, tuple[float, any]] = {}
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._lock = Lock()

    def get(self, key: str) -> any:
        with self._lock:
            entry = self._store.get(key)
            if entry and entry[0] > time.time():
                return entry[1]
            if entry:
                del self._store[key]
            return None

    def set(self, key: str, value: any):
        with self._lock:
            self._store[key] = (time.time() + self._ttl, value)
            expired = [k for k, v in self._store.items() if v[0] <= time.time()]
            for k in expired:
                del self._store[k]
            if len(self._store) > self._max_size:
                oldest = sorted(self._store.keys(), key=lambda k: self._store[k][0])
                for k in oldest[:len(oldest) // 2]:
                    del self._store[k]

_detail_cache = _TTLCache(ttl_seconds=300)
_project_detail_cache = _TTLCache(ttl_seconds=300)
_text_search_cache = _TTLCache(ttl_seconds=60, max_size=200)

# --- Pydantic Schemas for Tool Inputs ---
# These schemas enforce type safety and provide descriptions for the LLM.

class StructuredSearchInput(BaseModel):
    """Input schema for the structured_property_search tool."""
    location: Optional[str] = Field(
        default=None, 
        description="The city, neighborhood, or area to search for properties in. Example: 'Gurgaon'"
    )
    property_type: Optional[str] = Field(
        default=None, 
        description="The type of property, such as 'apartment', 'villa', or 'plot'."
    )
    min_price: Optional[float] = Field(
        default=None, 
        description="The minimum budget for the property in Indian Rupees (INR)."
    )
    max_price: Optional[float] = Field(
        default=None, 
        description="The maximum budget for the property in Indian Rupees (INR)."
    )
    bedrooms: Optional[int] = Field(
        default=None, 
        description="The specific number of bedrooms required, e.g., 2 for a 2BHK."
    )
    page: int = Field(
        default=1, 
        description="The page number of results to fetch. Use 1 for a new search."
    )

class ListingDetailsInput(BaseModel):
    """Input schema for the get_listing_details tool."""
    listing_id: str = Field(
        description="The unique UUID of the property or project to get details for. This ID must be retrieved from a previous search."
    )

class TextSearchInput(BaseModel):
    """Input schema for the full_text_property_search tool."""
    query: str = Field(
        description="The specific name of a property or project to search for. Example: 'Azure Heights'"
    )

class SemanticSearchInput(BaseModel):
    """Input schema for the semantic_property_search tool."""
    query: str = Field(
        description="A descriptive or conceptual query. Example: 'a quiet family home with a garden'"
    )

class KnowledgeSearchInput(BaseModel):
    """Input schema for the knowledge_web_search tool."""
    query: str = Field(
        description="A general real estate question. Example: 'what is stamp duty in Gurgaon?'"
    )

class ProjectTextSearchInput(BaseModel):
    """Input schema for the project_text_search tool."""
    query: str = Field(
        description="The specific name of a project to search for. Example: 'Sobha Hartland'"
    )

class ProjectSlugInput(BaseModel):
    """Input schema for the get_project_details_by_slug tool."""
    slug: str = Field(
        description="The URL slug of the project to get details for. Must be retrieved from a previous project search result."
    )

# --- Tool Definitions ---

@tool(args_schema=StructuredSearchInput)
async def structured_property_search(
    location: Optional[str] = None, 
    property_type: Optional[str] = None, 
    min_price: Optional[float] = None, 
    max_price: Optional[float] = None, 
    bedrooms: Optional[int] = None, 
    page: int = 1
) -> str:
    """
    Use this tool for specific, filtered searches for properties when the user provides concrete criteria.
    This is the primary tool for new searches and for refining existing searches.
    For example, use this for queries like: 'find 2 bedroom apartments in Gurgaon under 50 lakhs'.
    To show more results for a previous search ('show me more', 'next page'), use this tool and increment the 'page' number.
    Do NOT use this for vague or conceptual searches like 'something modern' or for finding a property by its name.
    """
    logger.info(f"TOOL CALL: structured_property_search with args: {{location: {location}, property_type: {property_type}, page: {page}}}")
    params = { 
        "p_location": location, 
        "p_property_type": property_type, 
        "p_min_price": min_price, 
        "p_max_price": max_price, 
        "p_bedrooms": bedrooms, 
        "p_amenities": None, 
        "p_exclude_ids": [], 
        "p_page": page, 
        "p_limit": 5 # Fetch 5 items per page for the chat
    }
    try:
        response = await asyncio.to_thread(supabase_client.rpc("search_all_properties", params).execute)
        if response.data:
            return json.dumps(response.data)
        else:
            return "No properties found matching your criteria."
    except Exception as e:
        logger.error(f"Error in structured_property_search: {e}")
        return f"Error: An error occurred while searching: {e}"

@tool(args_schema=TextSearchInput)
async def full_text_property_search(query: str) -> str:
    """
    Use this tool ONLY when the user is searching for a property or project by its specific name.
    For example, use this for queries like: 'tell me about Azure Heights' or 'do you have anything in DLF Crest?'.
    Do NOT use this for general filtered searches (e.g., 'apartments in Gurgaon').
    """
    logger.info(f"TOOL CALL: full_text_property_search for query: '{query}'")
    params = {"p_query": query, "p_exclude_ids": []}
    try:
        response = await asyncio.to_thread(supabase_client.rpc("text_search_properties", params).execute)
        if response.data:
            return json.dumps(response.data)
        else:
            return f"No properties found for '{query}'."
    except Exception as e:
        logger.error(f"Error in full_text_property_search: {e}")
        return f"Error: An error occurred while searching: {e}"

@tool(args_schema=SemanticSearchInput)
async def semantic_property_search(query: str) -> str:
    """
    Use this tool for vague, conceptual, or descriptive searches.
    For example: 'find a quiet family home with a garden' or 'show me properties with a modern design'.
    Do NOT use this for specific, filtered searches (e.g., '2bhk in Gurgaon').
    """
    logger.info(f"TOOL CALL: semantic_property_search for query: '{query}'")
    try:
        # Embedding must be done in a sync-safe way for FastAPI
        from api_py.shared_embedding import embedding_engine
        query_embedding = await asyncio.to_thread(embedding_engine.embed_query, query)
        
        params = {"query_embedding": query_embedding, "match_threshold": 0.10, "match_count": 10}
        response = await asyncio.to_thread(supabase_client.rpc("match_property_chunks", params).execute)
        
        if not response.data:
            return "No properties found for that description."

        # De-duplicate and fetch full summaries
        property_ids = list(dict.fromkeys(item['id'] for item in response.data if item.get('id')))
        if not property_ids:
            return "No properties found for that description."

        summary_response = await asyncio.to_thread(
            supabase_client.from_("unified_listings_view")
            .select("*")
            .in_("id", property_ids)
            .limit(5)
            .execute
        )
        return json.dumps(summary_response.data) if summary_response.data else "No properties found."

    except Exception as e:
        logger.error(f"Error in semantic_property_search: {e}", exc_info=True)
        return f"Error: An error occurred during semantic search: {e}"

@tool(args_schema=ListingDetailsInput)
async def get_listing_details(listing_id: str) -> str:
    """
    Use this tool to get all detailed information about a single, specific property or project.
    You MUST have the 'listing_id' from a previous search result to use this tool.
    Use this when the user asks for more details about a property you have already shown them (e.g., 'tell me about the second one').
    """
    logger.info(f"TOOL CALL: get_listing_details for listing ID: {listing_id}")
    if not listing_id:
        return "Error: A valid listing_id must be provided."
    try:
        UUID(listing_id)
    except (ValueError, TypeError):
        return f"Error: The provided ID '{listing_id}' is not a valid UUID."

    cached = _detail_cache.get(listing_id)
    if cached:
        logger.info(f"get_listing_details cache HIT for {listing_id}")
        return cached

    try:
        response = await asyncio.to_thread(
            supabase_client.rpc('get_listing_details', {'p_listing_id': listing_id})
            .execute
        )

        if not response.data:
            return "Error: No data found for this ID."

        details_object = response.data[0] if isinstance(response.data, list) else response.data
        result = json.dumps(details_object)
        _detail_cache.set(listing_id, result)
        return result

    except Exception as e:
        logger.error(f"Error in get_listing_details tool: {e}", exc_info=True)
        return f"An error occurred while fetching details. Error: {e}"

@tool(args_schema=KnowledgeSearchInput)
async def knowledge_web_search(query: str) -> str:
    """
    Use this tool to answer general real estate questions that do NOT involve finding specific property listings.
    For example: 'what is stamp duty in Gurgaon?', 'how do I get a home loan in India?', 'best schools in South Delhi'.
    """
    logger.info(f"TOOL CALL: knowledge_web_search for query: '{query}'")
    if not TAVILY_API_KEY:
        return "Error: Knowledge search is not configured."
    try:
        tavily_tool = TavilySearchResults(max_results=3, api_key=TAVILY_API_KEY)
        results = await tavily_tool.ainvoke(query)
        logger.info(f"Raw tavily results: {results}")

        return "\n".join([res["content"] for res in results])
    except Exception as e:
        logger.error(f"Error in knowledge_web_search: {e}")
        return f"Error: An error occurred while searching the web: {e}"

@tool(args_schema=ProjectTextSearchInput)
async def project_text_search(query: str) -> str:
    """
    Use this tool ONLY when the user is searching for a project / real estate development by its specific name.
    For example, use this for queries like: 'tell me about Sobha Hartland' or 'show me Azizi Venice'.
    This searches the dedicated projects index and returns project-level results.
    Do NOT use this for individual property listings — use full_text_property_search for those.
    """
    logger.info(f"TOOL CALL: project_text_search for query: '{query}'")
    try:
        params = {"p_query": query, "p_exclude_ids": []}
        response = await asyncio.to_thread(supabase_client.rpc("text_search_properties", params).execute)

        if not response.data:
            return f"No projects found for '{query}'."

        projects = [item for item in response.data if item.get('listing_type') == 'project']
        if not projects:
            return f"No projects found for '{query}'."

        return json.dumps(projects)

    except Exception as e:
        logger.error(f"Error in project_text_search: {e}")
        return f"Error: An error occurred while searching for projects: {e}"

@tool(args_schema=ProjectSlugInput)
async def get_project_details_by_slug(slug: str) -> str:
    """
    Use this tool to get all detailed information about a single project using its URL slug.
    You MUST have the 'slug' from a previous project search result to use this tool.
    Use this when the user asks for more details about a project you have already shown them.
    Returns complete project data including images, amenities, FAQs, unit configurations, and videos.
    """
    logger.info(f"TOOL CALL: get_project_details_by_slug for slug: '{slug}'")
    if not slug:
        return "Error: A valid slug must be provided."

    cached = _project_detail_cache.get(slug)
    if cached:
        logger.info(f"get_project_details_by_slug cache HIT for '{slug}'")
        return cached

    try:
        response = await asyncio.to_thread(
            supabase_client.rpc('get_project_by_slug', {'p_slug': slug})
            .execute
        )

        if not response.data:
            return f"Error: No project found with slug '{slug}'."

        details = response.data[0] if isinstance(response.data, list) else response.data
        result = json.dumps(details)
        _project_detail_cache.set(slug, result)
        return result

    except Exception as e:
        logger.error(f"Error in get_project_details_by_slug: {e}", exc_info=True)
        return f"An error occurred while fetching project details. Error: {e}"

# --- Tool Registry ---
tools = {
    "structured_property_search": structured_property_search,
    "full_text_property_search": full_text_property_search,
    "semantic_property_search": semantic_property_search,
    "get_listing_details": get_listing_details,
    "knowledge_web_search": knowledge_web_search,
    "project_text_search": project_text_search,
    "get_project_details_by_slug": get_project_details_by_slug,
}
