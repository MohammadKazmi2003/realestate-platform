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
from typing import Optional, List
from uuid import UUID

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
        # Validate UUID
        UUID(listing_id)
        response = await asyncio.to_thread(
            supabase_client.rpc('get_listing_details', {'p_listing_id': listing_id})
            .execute
        )
        
        if not response.data:
            return "Error: No data found for this ID."
        
        # The RPC returns a list, even for a single item
        details_object = response.data[0] if isinstance(response.data, list) else response.data
        return json.dumps(details_object)

    except (ValueError, TypeError):
        return f"Error: The provided ID '{listing_id}' is not a valid UUID. Please find the correct ID from the context."
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

# --- Tool Registry ---
# A dictionary to map tool names to their callable functions
tools = {
    "structured_property_search": structured_property_search,
    "full_text_property_search": full_text_property_search,
    "semantic_property_search": semantic_property_search,
    "get_listing_details": get_listing_details,
    "knowledge_web_search": knowledge_web_search,
}
