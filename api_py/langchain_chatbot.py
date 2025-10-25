import os
import asyncio
import logging
import json
from typing import List, Dict, Any, Optional, TypedDict, Literal, Set
from uuid import UUID
import hashlib

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, AIMessage, BaseMessage, ToolMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_groq import ChatGroq
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from supabase import create_client, Client
from langchain_community.tools.tavily_search import TavilySearchResults
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver # Import MemorySaver for simple state persistence
from bs4 import BeautifulSoup
from cachetools import TTLCache

# --- Environment and Global Setup ---
load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Configuration & Clients ---
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY")

if not all([SUPABASE_URL, SUPABASE_SERVICE_KEY, GROQ_API_KEY, TAVILY_API_KEY]):
    raise ValueError("One or more required environment variables are missing (Supabase URL/Key, Groq Key, Tavily Key).")

try:
    supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
except Exception as e:
    logger.error(f"Failed to initialize clients: {e}")
    raise

router = APIRouter()

# --- Dual-Model Architecture ---
llm_router = ChatGroq(temperature=0, model_name="llama-3.1-8b-instant", api_key=GROQ_API_KEY)
llm_generator = ChatGroq(temperature=0.1, model_name="llama-3.3-70b-versatile", api_key=GROQ_API_KEY) # Increased creativity slightly

# --- Pydantic Models ---
class Message(BaseModel):
    role: str
    content: str
    properties: Optional[List[Dict[str, Any]]] = None

class ChatRequest(BaseModel):
    messages: List[Message]
    # Use conversation_id for persistent state across requests
    conversation_id: str = Field(default_factory=lambda: f"conv_{hashlib.sha1(os.urandom(16)).hexdigest()}")

class PropertyDetails(BaseModel):
    id: str
    title: Optional[str] = None
    bhk: Optional[str] = None # Added BHK
    price: Optional[float] = None
    location: Optional[str] = None
    amenities: Optional[List[str]] = None
    images: Optional[List[str]] = None
    # Add other relevant details you want to store
    # ...
    full_details_fetched: bool = False # Flag to track if full details were fetched

class ToolChoice(BaseModel):
    tool_name: Literal[
        "structured_property_search", "full_text_property_search", "semantic_property_search",
        "get_listing_details", "knowledge_web_search",
        "request_clarification", # Added for fallback
        "respond_from_context", # Added for context-based response
        "respond_to_user" # General response fallback (renamed from old implementation)
    ] = Field(..., description="The tool or action to use based on the user's query and context.")
    tool_input: Optional[Dict[str, Any]] = Field(None, description="The input parameters for the chosen tool. Should be null for 'request_clarification', 'respond_from_context', 'respond_to_user'.")

# --- Caching ---
# Simple TTL cache for LLM responses and potentially tool outputs
# Cache LLM responses for 1 hour
llm_cache = TTLCache(maxsize=100, ttl=3600)
# Cache tool results for 10 minutes
tool_cache = TTLCache(maxsize=50, ttl=600)

# --- Helper Functions ---

def strip_html(text: Optional[str]) -> str:
    """Remove HTML tags from a string."""
    if not text:
        return ""
    # Ensure text is treated as a string
    text = str(text)
    # Use 'html.parser' for robustness, ignore Unicode errors if any
    soup = BeautifulSoup(text, "html.parser", from_encoding='utf-8')
    return soup.get_text(" ", strip=True)

def format_property_minimal(prop: Dict[str, Any]) -> str:
    """Formats minimal property info for display."""
    if not prop: return ""
    price_str = f"₹{prop.get('price'):,}" if prop.get('price') else "Price on request"
    bhk_str = prop.get('bhk', '') # Assume 'bhk' field exists after extraction
    location_str = prop.get('location', 'N/A')
    return f"**{prop.get('title', 'N/A')}**: {bhk_str} in {location_str} - {price_str} (ID: {prop.get('id')})"

def format_properties_for_llm(properties: List[Dict[str, Any]]) -> str:
    """Formats a list of properties concisely for LLM context."""
    if not properties:
        return "No properties found or in context."
    summary_lines = ["Properties currently in context:"]
    for i, prop in enumerate(properties):
        price = f"₹{prop.get('price'):,}" if prop.get('price') else "Price on request"
        summary_lines.append(
            f"{i+1}. ID: {prop.get('id')}, Title: {prop.get('title', 'N/A')}, Price: {price}, Location: {prop.get('location', 'N/A')}"
        )
    return "\n".join(summary_lines)

def format_property_details_for_llm(details: Dict[str, Any]) -> str:
    """Formats detailed property info for LLM context (improved)."""
    if not details:
        return "No details available."

    output_lines = []

    def format_value(val):
        """Helper to format individual values."""
        if val is None or val == '': return None
        if isinstance(val, bool): return "Yes" if val else "No"
        # Format large numbers as currency or plain numbers
        if isinstance(val, (int, float)):
            try:
                # Attempt currency formatting for potential prices
                if abs(val) >= 10000: return f"₹{val:,.0f}"
                # Otherwise, just format as number (handle potential floats)
                return f"{val:n}" if isinstance(val, float) else str(val)
            except (ValueError, TypeError):
                return str(val) # Fallback for non-numeric types passed erroneously
        return strip_html(str(val)) # Strip HTML from string values

    # Key fields first
    priority_keys = ['title', 'price', 'location_text', 'type', 'description']
    for key in priority_keys:
        if key in details:
            formatted_val = format_value(details.get(key))
            if formatted_val:
                 formatted_key = key.replace('_', ' ').title()
                 output_lines.append(f"{formatted_key}: {formatted_val}")

    output_lines.append("\n**Key Features & Specs:**")

    # Process nested details (residential, commercial, land)
    details_map = {
        'details_residential': 'Residential Details',
        'details_commercial': 'Commercial Details',
        'details_land': 'Land Details'
    }
    for detail_key, detail_title in details_map.items():
        if details.get(detail_key) and isinstance(details[detail_key], list) and details[detail_key]:
            detail_data = details[detail_key][0] # Assuming only one entry
            output_lines.append(f"\n_{detail_title}_:")
            for sub_key, sub_val in detail_data.items():
                 # Handle nested objects like 'bhk_types', 'office_type' etc.
                 if isinstance(sub_val, dict) and sub_val:
                      item_name = sub_val.get('name') or sub_val.get('label')
                      if item_name:
                          output_lines.append(f"  {sub_key.replace('_', ' ').title()}: {item_name}")
                 else:
                    formatted_sub_val = format_value(sub_val)
                    if formatted_sub_val and sub_key != 'property_id': # Avoid redundant ID
                        output_lines.append(f"  {sub_key.replace('_', ' ').title()}: {formatted_sub_val}")

    # Process lists (amenities, furnishings etc.)
    list_map = {
        'lookup_amenities': 'Amenities',
        'lookup_furnishing_items': 'Furnishings Included',
        'lookup_other_rooms': 'Other Rooms',
        'lookup_location_advantages': 'Location Advantages',
        'lookup_land_features': 'Land Features',
        'faqs': 'FAQs'
    }
    for list_key, list_title in list_map.items():
         if details.get(list_key) and isinstance(details[list_key], list) and details[list_key]:
             items = []
             if list_key == 'faqs':
                 # Special formatting for FAQs
                 output_lines.append(f"\n**{list_title}:**")
                 for item in details[list_key]:
                      q = item.get('question')
                      a = item.get('answer')
                      if q and a: output_lines.append(f"  Q: {q}\n  A: {a}")
             else:
                 # Generic list formatting
                 items = [item.get('name') for item in details[list_key] if item.get('name')]
                 if items: output_lines.append(f"\n**{list_title}:** {', '.join(items)}")

    return "\n".join(output_lines)

# --- Tool Definitions ---
# Wrap tool calls with caching
async def cached_tool_call(cache_key: str, func, *args, **kwargs):
    if cache_key in tool_cache:
        logger.info(f"CACHE HIT for tool: {func.__name__} with key: {cache_key[:50]}...")
        return tool_cache[cache_key]
    
    logger.info(f"CACHE MISS for tool: {func.__name__}. Calling tool...")
    result = await func(*args, **kwargs)
    tool_cache[cache_key] = result
    return result

# Original tool functions remain largely the same, but now called via cached_tool_call
@tool
async def structured_property_search(
    location: Optional[str] = None, property_type: Optional[str] = None,
    min_price: Optional[float] = None, max_price: Optional[float] = None,
    bedrooms: Optional[int] = None, page: int = 1
) -> str:
    """Searches properties using structured criteria. Use for specific filters like location, price, bedrooms, property type. Also use for pagination requests ('show more', 'next page'). Always include the 'page' number."""
    logger.info(f"Executing structured_property_search: loc={location}, type={property_type}, beds={bedrooms}, page={page}")
    params = {
        "p_location": location, "p_property_type": property_type, "p_min_price": min_price,
        "p_max_price": max_price, "p_bedrooms": bedrooms, "p_amenities": None,
        "p_exclude_ids": [], # Exclude IDs handled in AgentState now
        "p_page": page, "p_limit": 5 # Limit results per page
    }
    try:
        response = await asyncio.to_thread(supabase_client.rpc("search_all_properties", params).execute)
        if response.data:
            logger.info(f"Structured search found {len(response.data)} properties for page {page}.")
            return json.dumps(response.data, default=str)
        else:
            logger.info(f"Structured search found no properties for page {page}.")
            return "No properties found matching your criteria."
    except Exception as e:
        logger.error(f"Error during structured search RPC: {e}", exc_info=True)
        return f"Error: Could not perform structured search. {e}"

@tool
async def full_text_property_search(query: str) -> str:
    """Performs a full-text search for properties by specific name or title. Use when the user asks about a property by its exact name."""
    logger.info(f"Executing full_text_property_search for query: '{query}'")
    params = {"p_query": query, "p_exclude_ids": []}
    try:
        response = await asyncio.to_thread(supabase_client.rpc("text_search_properties", params).execute)
        if response.data:
             logger.info(f"Full-text search found {len(response.data)} properties.")
             return json.dumps(response.data, default=str)
        else:
            logger.info(f"Full-text search found no properties for '{query}'.")
            return f"No properties found for '{query}'."
    except Exception as e:
        logger.error(f"Error during full-text search RPC: {e}", exc_info=True)
        return f"Error: Could not perform full-text search. {e}"

@tool
async def semantic_property_search(query: str) -> str:
    """Searches properties based on descriptive queries using vector embeddings. Use for conceptual searches like 'quiet apartment near park' or 'modern villa with sea view'."""
    logger.info(f"Executing semantic_property_search for query: '{query}'")
    try:
        query_embedding = embedding_engine.embed_query(query) # Assuming embedding_engine is available
        params = {"query_embedding": query_embedding, "match_threshold": 0.75, "match_count": 10}
        response = await asyncio.to_thread(supabase_client.rpc("match_property_chunks", params).execute)

        if not response.data:
            logger.info(f"Semantic search found no properties for query: '{query}'")
            return "No properties found for that description."

        # Get unique parent property/project IDs from chunk results
        parent_ids = list(dict.fromkeys(item['id'] for item in response.data if item.get('id')))

        if not parent_ids:
             logger.info(f"Semantic search found chunks but no valid parent IDs for query: '{query}'")
             return "Found related info, but couldn't link to specific properties."

        # Fetch full property details for the unique IDs
        final_properties_query = supabase_client.from_("unified_listings_view").select("*").in_("id", parent_ids).limit(5)
        final_properties_result = await asyncio.to_thread(final_properties_query.execute)

        if final_properties_result.data:
             logger.info(f"Semantic search retrieved details for {len(final_properties_result.data)} properties.")
             return json.dumps(final_properties_result.data, default=str)
        else:
            logger.info(f"Semantic search could not retrieve full details for found IDs: {parent_ids}")
            return "Could not retrieve details for the found properties."

    except Exception as e:
        logger.error(f"Error during semantic search: {e}", exc_info=True)
        return f"Error: Could not perform semantic search. {e}"

@tool
async def get_listing_details(listing_id: str) -> str:
    """Fetches complete details for a specific property or project using its unique ID. Use when the user asks for more details about a specific property already mentioned or listed."""
    logger.info(f"Executing get_listing_details for ID: {listing_id}")
    if not listing_id: return "Error: A valid listing_id must be provided."
    try:
        UUID(listing_id) # Validate UUID format
        params = {'p_listing_id': listing_id}
        response = await asyncio.to_thread(supabase_client.rpc('get_listing_details', params).execute)

        if not response.data:
            logger.warning(f"No details found for listing ID: {listing_id}")
            return "Error: No details found for this ID."

        # The RPC might return a list with one item, or just the item directly
        details_object = response.data[0] if isinstance(response.data, list) else response.data
        if not isinstance(details_object, dict):
            logger.error(f"Unexpected data format from get_listing_details for ID {listing_id}: {type(details_object)}")
            return "Error: Received unexpected data format for details."

        logger.info(f"Successfully fetched details for listing ID: {listing_id}")
        return json.dumps(details_object, default=str)

    except (ValueError, TypeError):
        logger.warning(f"Invalid UUID format provided for get_listing_details: {listing_id}")
        return f"Error: Invalid ID format '{listing_id}'. Please provide a valid property ID."
    except Exception as e:
        logger.error(f"Error in get_listing_details RPC: {e}", exc_info=True)
        return f"Error: Could not fetch details. {e}"

@tool
async def knowledge_web_search(query: str) -> str:
    """Searches the web for general real estate questions, market trends, legal info, etc., not specific property listings."""
    logger.info(f"Executing knowledge_web_search for query: '{query}'")
    try:
        tavily_tool = TavilySearchResults(max_results=2, api_key=TAVILY_API_KEY)
        results = await tavily_tool.ainvoke(query)
        # Combine content from results
        combined_content = "\n\n".join([res.get("content", "") for res in results])
        logger.info(f"Knowledge search returned content length: {len(combined_content)}")
        return combined_content if combined_content else "No relevant information found on the web."
    except Exception as e:
        logger.error(f"Error during knowledge web search: {e}", exc_info=True)
        return f"Error: Could not perform web search. {e}"

# --- Tool Registry ---
tools_map = {
    "structured_property_search": structured_property_search,
    "full_text_property_search": full_text_property_search,
    "semantic_property_search": semantic_property_search,
    "get_listing_details": get_listing_details,
    "knowledge_web_search": knowledge_web_search,
}

# --- LangGraph State Definition ---
class AgentState(TypedDict):
    messages: List[BaseMessage]
    # Stores properties shown in THIS turn for UI display
    current_response_properties: Optional[List[Dict[str, Any]]]
    # **CONTEXT STORE**: Stores all unique properties encountered in the conversation
    shown_properties: Dict[str, PropertyDetails]
    # Criteria used for the last search (for pagination)
    last_search_criteria: Optional[Dict[str, Any]]
    # Current page number for the last search
    page: int
    # ID of the property the user is currently asking about
    focused_property_id: Optional[str]
    # Full details of the focused property (if fetched)
    focused_property_details: Optional[Dict[str, Any]]
    # Output of the last chosen tool
    tool_output: Optional[str]
    # Tool choice decided by the router
    tool_choice: Optional[ToolChoice]
    # Keep track of IDs from the last search for efficient pagination (optional)
    last_search_ids: Set[str]

# --- Agent Nodes ---

async def agent_router_node(state: AgentState) -> Dict[str, Any]:
    """Selects the appropriate tool or action based on the conversation history and current context."""
    logger.info("--- NODE: Agent Router ---")

    # Generate cache key based on messages and relevant state
    cache_key_context = {
        "last_message": state["messages"][-1].content,
        "shown_prop_count": len(state.get("shown_properties", {})),
        "focused_id": state.get("focused_property_id"),
        "details_available": bool(state.get("focused_property_details")),
        "page": state.get("page", 1)
    }
    cache_key = f"router_{hashlib.sha1(json.dumps(cache_key_context, sort_keys=True).encode()).hexdigest()}"

    if cache_key in llm_cache:
         logger.info(f"CACHE HIT for router node.")
         cached_choice = llm_cache[cache_key]
         # Need to handle potential focus update even on cache hit
         focused_id_update = {}
         if cached_choice.tool_name == "get_listing_details" and cached_choice.tool_input:
              new_focused_id = cached_choice.tool_input.get("listing_id")
              if new_focused_id:
                  focused_id_update["focused_property_id"] = new_focused_id
         return {"tool_choice": cached_choice, **focused_id_update}

    logger.info("CACHE MISS for router node.")
    system_template = """You are a specialized router agent for a real estate chatbot. Your task is to analyze the user's latest query, the conversation history, and the current context (shown properties, focused property) to select the BEST tool or action and its parameters.

    **Available Tools/Actions:**
    - `structured_property_search`: Use for searches with specific filters (location, price, beds, type) OR pagination requests ("show more"). Requires `page` parameter.
    - `full_text_property_search`: Use ONLY when the user asks about a property by its exact name AND it's NOT already in `shown_properties_summary`.
    - `semantic_property_search`: Use for descriptive/conceptual searches (e.g., "apartment near a park").
    - `get_listing_details`: Use when the user asks for *more details* about a specific property already in `shown_properties_summary` (by name or reference like "the first one"). Requires `listing_id`.
    - `respond_from_context`: Use if the user asks a question about the `focused_property_details` that you ALREADY have.
    - `knowledge_web_search`: Use for general real estate questions (market trends, advice, definitions) NOT about specific listings.
    - `request_clarification`: Use if the user's query is too ambiguous, off-topic, or lacks necessary details for a search or action.
    - `respond_to_user`: Use for simple greetings, acknowledgements, or if no other tool fits but a direct response is needed.

    **Context Provided:**
    - `history`: Recent conversation messages.
    - `current_session_page`: The page number of the last `structured_property_search`.
    - `last_search_criteria`: Filters used in the last `structured_property_search`.
    - `shown_properties_summary`: List of properties already shown (ID, Title). Check this FIRST for follow-ups.
    - `focused_property_id`: ID of the property currently being discussed.
    - `focused_property_details_available`: "Yes" if full details for the focused property have been fetched.

    **Decision Process:**
    1.  **Analyze User Query:** What is the user asking? New search? Follow-up? General question? Ambiguous?
    2.  **Check Context (IMPORTANT!):**
        * Does the query refer to a property in `shown_properties_summary` (by name or index)? If yes, use `get_listing_details` (if details not yet fetched) or `respond_from_context` (if details are available).
        * Is it a pagination request ("show more", "next") AND `last_search_criteria` exists? If yes, use `structured_property_search` with incremented `page`.
    3.  **Select Tool based on Intent:**
        * Specific Filters => `structured_property_search` (page=1 if new).
        * Descriptive Query => `semantic_property_search`.
        * Specific Name (NOT in context) => `full_text_property_search`.
        * General Question => `knowledge_web_search`.
        * Ambiguous/Off-topic => `request_clarification`.
        * Simple interaction => `respond_to_user`.
    4.  **Determine Parameters:** Extract necessary inputs (location, price, query, listing_id, page). For pagination, reuse `last_search_criteria` and increment `page`.

    **Example Scenarios:**
    - User: "Show me 2 BHKs in Mumbai under 1 Cr." => `structured_property_search`, input: {location: "Mumbai", bedrooms: 2, max_price: 10000000, page: 1}
    - User: "Tell me more about the second property." (Property ID 'xyz' is 2nd in `shown_properties_summary`) => `get_listing_details`, input: {listing_id: "xyz"}
    - User: "Does it have a pool?" (`focused_property_details_available` is "Yes") => `respond_from_context`, input: null
    - User: "What are the stamp duty rates?" => `knowledge_web_search`, input: {query: "stamp duty rates in India"}
    - User: "Find something nice." => `request_clarification`, input: null
    - User: "Thanks!" => `respond_to_user`, input: null
    - User: "Show me more." (`last_search_criteria` exists, `current_session_page` is 1) => `structured_property_search`, input: {...last_search_criteria, page: 2}

    **Current Context:**
    {context}
    """
    context_data = {
        "current_session_page": state.get('page', 1),
        "last_search_criteria": state.get('last_search_criteria'),
        "shown_properties_summary": [{'id': pid, 'title': pinfo.get('title', 'N/A')} for pid, pinfo in state.get('shown_properties', {}).items()],
        "focused_property_id": state.get('focused_property_id'),
        "focused_property_details_available": "Yes" if state.get('focused_property_details') else "No"
    }
    context_str = json.dumps(context_data, indent=2, default=str)

    parser = llm_router.with_structured_output(ToolChoice)
    prompt = ChatPromptTemplate.from_messages([("system", system_template), HumanMessage(content=state["messages"][-1].content)])
    chain = prompt | parser

    tool_choice = await chain.ainvoke({"context": context_str, "history": state["messages"]}) # Pass history if needed

    logger.info(f"LLM Router chose: {tool_choice.tool_name} with input: {tool_choice.tool_input}")

    # Update focused property ID if get_listing_details is chosen
    focused_id_update = {}
    if tool_choice.tool_name == "get_listing_details" and tool_choice.tool_input:
        new_focused_id = tool_choice.tool_input.get("listing_id")
        if new_focused_id:
            focused_id_update["focused_property_id"] = new_focused_id
            # Clear old details when focusing on a new property
            if new_focused_id != state.get("focused_property_id"):
                 focused_id_update["focused_property_details"] = None

    # Cache the result before returning
    llm_cache[cache_key] = tool_choice
    return {"tool_choice": tool_choice, **focused_id_update}

async def tool_executor_node(state: AgentState) -> Dict[str, Any]:
    """Executes the chosen tool and returns the output."""
    logger.info("--- NODE: Tool Executor ---")
    tool_choice = state.get("tool_choice")
    if not tool_choice or tool_choice.tool_name in ["request_clarification", "respond_from_context", "respond_to_user"]:
        # These actions don't involve external tool calls in this node
        logger.info(f"Skipping tool execution for action: {tool_choice.tool_name if tool_choice else 'None'}")
        return {"tool_output": None} # Return None to indicate no tool was run

    tool_to_call = tools_map.get(tool_choice.tool_name)
    if not tool_to_call:
        logger.error(f"Invalid tool name received: {tool_choice.tool_name}")
        return {"tool_output": f"Error: Invalid tool '{tool_choice.tool_name}' selected."}

    tool_input = tool_choice.tool_input or {}
    # Create a cache key for the tool call
    cache_key_context = {
        "tool_name": tool_choice.tool_name,
        "tool_input": tool_input,
        "last_search_ids": sorted(list(state.get("last_search_ids", set()))) # Include relevant context
    }
    cache_key = f"tool_{hashlib.sha1(json.dumps(cache_key_context, sort_keys=True, default=str).encode()).hexdigest()}"

    try:
        # Use caching wrapper
        output_str = await cached_tool_call(cache_key, tool_to_call.ainvoke, tool_input)
        
        # Log tool output size for monitoring
        logger.info(f"Tool '{tool_choice.tool_name}' output length: {len(output_str)}")
        
        update: Dict[str, Any] = {"tool_output": output_str}

        # Handle state updates based on tool output
        if not output_str.startswith("Error:"):
            try:
                parsed_output = json.loads(output_str)

                if tool_choice.tool_name in ["structured_property_search", "full_text_property_search", "semantic_property_search"]:
                    current_properties = parsed_output if isinstance(parsed_output, list) else []
                    update["current_response_properties"] = current_properties # Properties for this turn's UI
                    update["last_search_ids"] = {p.get('id') for p in current_properties if p.get('id')}

                    # Update last search criteria and page only for structured search
                    if tool_choice.tool_name == "structured_property_search":
                         # Preserve only the filter criteria, not page or exclude_ids
                        search_criteria = {k: v for k, v in tool_input.items() if k not in ['page', 'p_exclude_ids']}
                        update["last_search_criteria"] = search_criteria
                        update["page"] = tool_input.get('page', 1)
                    else:
                        # Clear old search criteria if it was a different search type
                        update["last_search_criteria"] = None
                        update["page"] = 1
                    
                    # Clear focused property if a new search occurs
                    update["focused_property_id"] = None
                    update["focused_property_details"] = None


                elif tool_choice.tool_name == "get_listing_details":
                    if isinstance(parsed_output, dict):
                        update["focused_property_details"] = parsed_output
                        # Ensure focused_property_id is also set correctly
                        update["focused_property_id"] = parsed_output.get('id')
                        # Clear properties meant for UI display as we're showing details now
                        update["current_response_properties"] = []
                    else:
                         logger.warning(f"get_listing_details did not return a dictionary: {type(parsed_output)}")
                         update["tool_output"] = "Error: Failed to parse property details."


            except json.JSONDecodeError:
                # Handle non-JSON output (e.g., from knowledge search or error messages)
                 if tool_choice.tool_name == "knowledge_web_search":
                     update["tool_output"] = output_str # Keep raw text
                 else:
                     logger.warning(f"Failed to parse JSON output from tool '{tool_choice.tool_name}'. Output: {output_str[:100]}...")
                     # Keep the raw output string if it's not JSON and not an error
                     if not output_str.startswith("Error:"):
                        update["tool_output"] = output_str
                     # If it IS an error string, it's already set in update["tool_output"]


        logger.info(f"State update after tool execution: { {k: (type(v).__name__ if k=='focused_property_details' and v else v) for k, v in update.items()} }") # Log update keys and types/values
        return update

    except Exception as e:
        logger.error(f"Error executing tool '{tool_choice.tool_name}': {e}", exc_info=True)
        return {"tool_output": f"Error: An unexpected error occurred while running the tool. {e}"}

async def generate_response_node(state: AgentState) -> Dict[str, Any]:
    """Generates the final response to the user based on the tool output and context."""
    logger.info("--- NODE: Generate Response ---")
    tool_choice = state.get("tool_choice")
    tool_output = state.get('tool_output')
    current_response_properties = state.get('current_response_properties')
    shown_properties = state.get('shown_properties', {})
    focused_property_details = state.get('focused_property_details')
    user_query = state["messages"][-1].content

    prompt_context = ""
    properties_to_add_to_context: List[Dict[str, Any]] = []

    if tool_choice:
        if tool_choice.tool_name == "request_clarification":
            prompt_context = "The user's request was unclear. Ask for more specific details (e.g., location, property type, budget)."
        elif tool_choice.tool_name == "respond_from_context":
            if focused_property_details:
                prompt_context = f"Answer the user's question using ONLY the following details about the property '{focused_property_details.get('title', 'N/A')}':\n{format_property_details_for_llm(focused_property_details)}"
            else:
                prompt_context = "Error: I was asked to respond from context, but I don't have the property details loaded."
                logger.error("respond_from_context chosen but focused_property_details is missing.")
        elif tool_choice.tool_name == "respond_to_user":
             prompt_context = "Generate a simple, friendly acknowledgement or closing response based on the user's last message."
        elif tool_output and tool_output.startswith("Error:"):
            prompt_context = f"An error occurred: {tool_output}. Apologize and ask the user to rephrase or try again."
            logger.error(f"Error passed to generator: {tool_output}")
        elif current_response_properties is not None: # Check specifically for search results
            properties_to_add_to_context = current_response_properties
            if properties_to_add_to_context:
                formatted_summaries = "\n".join([format_property_minimal(p) for p in properties_to_add_to_context])
                page_num = state.get('page', 1)
                page_info = f"(Page {page_num})" if page_num > 1 else ""
                prompt_context = f"Found the following properties {page_info}. Summarize them briefly and ask if they want more details on any specific property:\n{formatted_summaries}"
            else:
                prompt_context = "No additional properties were found matching the criteria. Inform the user and ask if they want to broaden the search."
        elif focused_property_details and tool_choice.tool_name == "get_listing_details":
             # Details were just fetched
             prompt_context = f"Here are the details for the requested property:\n{format_property_details_for_llm(focused_property_details)}\n\nSummarize the key information and ask if the user has specific questions about it."
             # Add fetched details to context store
             prop_id = focused_property_details.get('id')
             if prop_id:
                 shown_properties[prop_id] = PropertyDetails(
                     id=prop_id,
                     title=focused_property_details.get('title'),
                     # Extract BHK, Price, Location etc. from details if available
                     bhk= focused_property_details.get('details_residential', [{}])[0].get('bhk_types', {}).get('label'),
                     price=focused_property_details.get('price'),
                     location=focused_property_details.get('location_text'),
                     amenities=[a.get('name') for a in focused_property_details.get('lookup_amenities', []) if a.get('name')],
                     images=[img.get('media_url') for img in focused_property_details.get('property_media', []) if img.get('media_url')],
                     full_details_fetched=True
                 )
        elif tool_output and tool_choice.tool_name == "knowledge_web_search":
             prompt_context = f"Answer the user's general question based on this web search information:\n{tool_output}"
        else:
             prompt_context = "I don't have specific information for that request right now. Try asking in a different way."
             logger.warning(f"Unhandled state in generate_response_node. Tool: {tool_choice.tool_name if tool_choice else 'None'}, Tool Output: {tool_output is not None}, Properties: {current_response_properties is not None}, Details: {focused_property_details is not None}")
    else:
        prompt_context = "An unexpected routing error occurred. Ask the user to please repeat their request."
        logger.error("generate_response_node reached without a tool_choice.")

    # --- Update Context Store ---
    # Add newly shown properties from search results to the main context store
    for prop in properties_to_add_to_context:
        prop_id = prop.get('id')
        if prop_id and prop_id not in shown_properties:
             # Extract minimal details for context store initially
             bhk = None
             if prop.get('details_residential') and prop['details_residential']:
                 bhk = prop['details_residential'][0].get('bhk_types', {}).get('label')
             elif prop.get('bedrooms') is not None: # Fallback for unified view
                 bhk = f"{prop['bedrooms']} BHK" if prop['bedrooms'] > 0 else "Studio"

             shown_properties[prop_id] = PropertyDetails(
                 id=prop_id,
                 title=prop.get('title'),
                 bhk=bhk,
                 price=prop.get('price'),
                 location=prop.get('location') or prop.get('location_text'),
                 full_details_fetched=False # Mark as summary initially
             )

    # --- Generate Final Response using LLM ---
    system_template = """You are a helpful, friendly, and concise real estate assistant. Generate a final response based *only* on the provided 'Latest Information'.
    - If properties are listed, briefly summarize them using the provided format.
    - If details are provided, summarize the key points clearly.
    - If answering a question from context, be direct and use only the given details.
    - If asking for clarification, be polite and specific about what's needed.
    - If an error occurred, apologize and guide the user.
    - Keep responses conversational and easy to understand. Avoid overly technical jargon.
    - If listing properties, use markdown bullet points with the minimal format provided.
    """
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        # Provide previous messages for conversational context
        *state["messages"][:-1], # All messages except the last user query
        ("user", f"My last query was: '{user_query}'\n\nLatest Information:\n{prompt_context}")
    ])
    chain = prompt | llm_generator

    # Generate cache key for generator
    cache_key_context = {
        "last_message": user_query,
        "prompt_context": prompt_context, # Base key on the processed context
        "history_len": len(state["messages"])
    }
    cache_key = f"gen_{hashlib.sha1(json.dumps(cache_key_context, sort_keys=True).encode()).hexdigest()}"

    if cache_key in llm_cache:
        logger.info("CACHE HIT for generator node.")
        response_content = llm_cache[cache_key]
    else:
        logger.info("CACHE MISS for generator node. Calling LLM...")
        response = await chain.ainvoke({}) # History is already in the prompt
        response_content = response.content
        llm_cache[cache_key] = response_content # Cache the response


    final_messages = state["messages"] + [AIMessage(content=response_content)]

    # Clean up state for next turn: tool_output and tool_choice are transient
    return {
        "messages": final_messages,
        "current_response_properties": state.get("current_response_properties", []), # Pass properties for UI
        "shown_properties": shown_properties, # Persist updated context store
        "last_search_criteria": state.get("last_search_criteria"),
        "page": state.get("page"),
        "focused_property_id": state.get("focused_property_id"),
        "focused_property_details": state.get("focused_property_details"),
        "tool_output": None, # Clear transient state
        "tool_choice": None, # Clear transient state
        "last_search_ids": state.get("last_search_ids", set())
    }

# --- Graph Definition ---

# Define conditional edges
def should_execute_tool(state: AgentState) -> Literal["execute_tool_node", "generate_response_node"]:
    """Determines if a tool needs execution or if we can proceed to generation."""
    tool_choice = state.get("tool_choice")
    if tool_choice and tool_choice.tool_name not in ["request_clarification", "respond_from_context", "respond_to_user"]:
        logger.info(f"Routing to tool execution for: {tool_choice.tool_name}")
        return "execute_tool_node"
    else:
        logger.info(f"Routing directly to response generation. Action: {tool_choice.tool_name if tool_choice else 'None'}")
        return "generate_response_node"

def build_graph():
    workflow = StateGraph(AgentState)
    workflow.add_node("agent_router_node", agent_router_node)
    workflow.add_node("execute_tool_node", tool_executor_node) # Renamed for clarity
    workflow.add_node("generate_response_node", generate_response_node)

    workflow.set_entry_point("agent_router_node")

    # Conditional routing after the router
    workflow.add_conditional_edges(
        "agent_router_node",
        should_execute_tool,
        {
            "execute_tool_node": "execute_tool_node",
            "generate_response_node": "generate_response_node" # Directly generate if no tool needed
        }
    )

    # Always go to generation after execution
    workflow.add_edge("execute_tool_node", "generate_response_node")
    workflow.add_edge("generate_response_node", END)

    # Use MemorySaver for simple in-memory persistence keyed by conversation_id
    memory = MemorySaver()
    return workflow.compile(checkpointer=memory)

langgraph_app = build_graph()

# --- FastAPI Endpoint ---
@router.post("/api/chat_langchain")
async def chat_langchain_endpoint(chat_request: ChatRequest):
    """Main endpoint to handle chat requests and interact with the LangGraph agent."""
    if not chat_request.messages:
        raise HTTPException(status_code=400, detail="No messages provided.")

    latest_message = chat_request.messages[-1]
    if latest_message.role != 'user':
         raise HTTPException(status_code=400, detail="Last message must be from user.")

    # Config for LangGraph invocation (using conversation_id for state persistence)
    config = {"configurable": {"thread_id": chat_request.conversation_id}}

    # Prepare input for the graph
    graph_input: Dict[str, Any] = {"messages": [HumanMessage(content=latest_message.content)]}

    try:
        # Stream events from the graph invocation
        final_state = None
        async for event in langgraph_app.astream_events(graph_input, config=config, version="v1"):
            kind = event["event"]
            # Keep track of the latest state after each node completes
            if kind == "on_chain_end":
                current_state = event["data"]["output"]
                # Ensure the structure matches AgentState (handle potential intermediate formats)
                if isinstance(current_state, dict) and "messages" in current_state:
                     final_state = current_state
                     logger.debug(f"Graph ended. Final state keys: {final_state.keys()}")


        if not final_state or "messages" not in final_state or not final_state["messages"]:
             logger.error("Graph execution finished unexpectedly without valid final state or messages.")
             raise HTTPException(status_code=500, detail="Chatbot failed to generate a response.")

        # Extract the last AI message from the final state
        final_ai_message = final_state["messages"][-1]
        if not isinstance(final_ai_message, AIMessage):
             logger.error(f"Last message in final state is not AIMessage: {type(final_ai_message)}")
             # Fallback: find the last AIMessage if possible
             final_ai_message = next((m for m in reversed(final_state["messages"]) if isinstance(m, AIMessage)), None)
             if not final_ai_message:
                 raise HTTPException(status_code=500, detail="Chatbot failed to generate a final AI response.")

        # Extract properties to show in the UI for *this* turn
        properties_for_ui = final_state.get("current_response_properties", []) or []

        # Prepare the persistent session state to send back (excluding messages)
        # We fetch the full state again to ensure we have the latest persisted version
        current_persistent_state = await langgraph_app.get_state(config)
        session_state_to_return = {
            k: v for k, v in current_persistent_state.values.items()
            if k != 'messages' and k != 'tool_choice' and k != 'tool_output' and k != 'current_response_properties'
        }
        # Convert set to list for JSON serialization
        session_state_to_return['last_search_ids'] = list(session_state_to_return.get('last_search_ids', []))
        # Ensure shown_properties is JSON serializable
        session_state_to_return['shown_properties'] = {k: v.dict() for k, v in session_state_to_return.get('shown_properties', {}).items()}


        logger.info(f"Returning response for conversation {chat_request.conversation_id}. Properties count: {len(properties_for_ui)}")
        return {
            "text_response": final_ai_message.content,
            "properties": properties_for_ui,
            "session_state": session_state_to_return,
            "conversation_id": chat_request.conversation_id # Return conversation_id back to client
        }

    except Exception as e:
        logger.error(f"Error during LangGraph invocation for conversation {chat_request.conversation_id}: {e}", exc_info=True)
        # Attempt to get the current state even if there was an error
        try:
             current_persistent_state = await langgraph_app.get_state(config)
             session_state_on_error = {k: v for k, v in current_persistent_state.values.items() if k != 'messages'}
             session_state_on_error['last_search_ids'] = list(session_state_on_error.get('last_search_ids', []))
             session_state_on_error['shown_properties'] = {k: v.dict() for k, v in session_state_on_error.get('shown_properties', {}).items()}

        except Exception as state_err:
             logger.error(f"Failed to get state after error for conversation {chat_request.conversation_id}: {state_err}")
             session_state_on_error = {} # Fallback to empty state

        # Return a structured error response
        return {
            "text_response": f"Sorry, an internal error occurred: {e}. Please try again.",
            "properties": [],
            "session_state": session_state_on_error,
            "conversation_id": chat_request.conversation_id
        }

# Include the router in the main FastAPI app (if running directly or via search.py)
# app = FastAPI() # If running this file directly
# app.include_router(router)
# Or ensure search.py includes this router if that's the entry point.