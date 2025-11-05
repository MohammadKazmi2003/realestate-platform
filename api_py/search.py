import os
import re
import logging
from typing import List, Dict, Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client
from langchain_core.messages import HumanMessage, AIMessage

# --- Refactor Imports ---
# Import the compiled graph and data models from the refactored chatbot file
# ChatRequest model now includes `session_id`
from api_py.langchain_chatbot import app as langgraph_app, AgentState, ChatRequest, Message
from api_py.shared_embedding import embedding_engine
# ------------------------


# --- Environment and Global Setup ---
load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Configuration & Clients ---
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

if not all([SUPABASE_URL, SUPABASE_SERVICE_KEY]):
    raise ValueError("Supabase URL and Service Key must be set in environment variables.")

try:
    supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
except Exception as e:
    logger.error(f"Failed to initialize clients or models: {e}")
    raise

# --- Main FastAPI App Initialization ---
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Pydantic Models (Legacy Search) ---
class SearchRequest(BaseModel):
    query: str
    exclude_ids: List[str] = []

class SearchResponse(BaseModel):
    properties: List[Dict[str, Any]]
    new_exclude_ids: List[str]

# --- Helper Functions (Legacy Search) ---
def parse_query_for_filters(query: str) -> Dict[str, Any]:
    """
    A simple parser to extract structured filters from a natural language query.
    """
    filters = {}
    query_lower = query.lower()
    location_match = re.search(r'in\s+([a-z\s]+)', query_lower)
    if location_match:
        filters['p_location'] = location_match.group(1).strip()
    bedroom_match = re.search(r'(\d+)\s*bhk|(\d+)\s*bed', query_lower)
    if bedroom_match:
        filters['p_bedrooms'] = int(bedroom_match.group(1) or bedroom_match.group(2))
    price_match = re.search(r'(under|below|less than)\s*(\d+)', query_lower)
    if price_match:
        filters['p_max_price'] = float(price_match.group(2))
    if 'villa' in query_lower:
        filters['p_property_type'] = 'villa'
    elif 'apartment' in query_lower:
        filters['p_property_type'] = 'apartment'
    return filters

# --- Legacy Search Endpoint (Unchanged) ---
@app.post("/api/search", response_model=SearchResponse)
async def search(request: SearchRequest):
    """
    Handles initial, high-speed property searches without involving an LLM.
    """
    logger.info(f"Received search request with query: '{request.query}'")
    
    filters = parse_query_for_filters(request.query)
    filters["p_exclude_ids"] = request.exclude_ids

    try:
        structured_query = supabase_client.rpc("search_all_properties", filters)
        structured_result = structured_query.execute()
        
        if structured_result.data:
            logger.info(f"Structured search found {len(structured_result.data)} properties.")
            new_ids = [p['id'] for p in structured_result.data]
            return SearchResponse(
                properties=structured_result.data,
                new_exclude_ids=list(set(request.exclude_ids + new_ids))
            )
    except Exception as e:
        logger.error(f"Error during structured search: {e}")

    logger.info("Falling back to semantic search.")
    try:
        embedding = embedding_engine.embed_query(request.query)
        semantic_query = supabase_client.rpc(
            "match_property_chunks",
            {"query_embedding": embedding, "match_threshold": 0.75, "match_count": 10}
        )
        semantic_result = semantic_query.execute()

        if not semantic_result.data:
            logger.warning("All search strategies failed.")
            return SearchResponse(properties=[], new_exclude_ids=request.exclude_ids)

        property_ids = list(dict.fromkeys(
            item['id'] for item in semantic_result.data if item.get('id') and item['id'] not in request.exclude_ids
        ))

        if not property_ids:
            return SearchResponse(properties=[], new_exclude_ids=request.exclude_ids)

        final_properties_query = supabase_client.from_("unified_listings_view").select("*").in_("id", property_ids).limit(5)
        final_properties_result = final_properties_query.execute()
        
        logger.info(f"Semantic search found {len(final_properties_result.data)} properties.")
        new_ids = [p['id'] for p in final_properties_result.data]
        return SearchResponse(
            properties=final_properties_result.data,
            new_exclude_ids=list(set(request.exclude_ids + new_ids))
        )
        
    except Exception as e:
        logger.error(f"An unexpected error occurred during semantic search: {e}")
        raise HTTPException(status_code=500, detail="An error occurred during search.")


# --- LangGraph Chatbot Endpoint ---
@app.post("/api/chat_langchain")
async def chat_langchain_endpoint(chat_request: ChatRequest):
    """
    This is the main endpoint for the conversational agent.
    It takes the frontend request and invokes the compiled LangGraph app.
    """
    # MODIFIED: Log the session ID
    logger.info(f"Invoking LangGraph agent for session: {chat_request.session_id}...")
    
    # 1. Handle simple "close" message
    latest_query = chat_request.messages[-1].content.lower().strip()
    if latest_query in ['close', 'exit', 'goodbye', 'bye', "that's all", "thank you"]:
        return {"text_response": "You're welcome! Let me know if you need anything else.", "properties": [], "session_state": {}}
        
    # 2. Convert frontend messages to LangChain messages
    messages: List[BaseMessage] = []
    for msg in chat_request.messages:
        if msg.role == 'user':
            messages.append(HumanMessage(content=msg.content))
        else:
            content = f"{msg.content}"
            if msg.properties:
                content += f"\n[Displayed {len(msg.properties)} properties to user]"
            messages.append(AIMessage(content=content))

    # 3. Construct the initial state from the frontend's session state
    session_state = chat_request.session_state or {}
    initial_state: AgentState = {
        "messages": messages,
        "user_intent": None,
        # "is_ambiguous": False, # Note: These keys were in the old file but not in the new AgentState, removing them.
        # "clarification_question": None, #
        "search_criteria": session_state.get("search_criteria", {}),
        "last_successful_search": session_state.get("last_successful_search"),
        "page": session_state.get("page", 1),
        "properties_in_context": session_state.get("properties_in_context", []),
        "focused_property_id": session_state.get("focused_property_id"),
        "focused_property_details": session_state.get("focused_property_details"),
        "tool_choice": None,
        "tool_output": None,
        "properties_for_ui": None,
        # --- ADDED: Pass session_id into the graph state ---
        "session_id": chat_request.session_id,
        "session_memory": [], # This will be populated by the first node
        # ----------------------------------------------------
    }
    
    try:
        # 4. Invoke the LangGraph app
        final_state = await langgraph_app.ainvoke(initial_state, {"recursion_limit": 10})
        
        # 5. Extract the final response and the new state
        final_message = final_state['messages'][-1]
        
        # 6. Prepare the session state to send back to the frontend
        response_session_state = {
            "search_criteria": final_state.get("search_criteria"),
            "last_successful_search": final_state.get("last_successful_search"),
            "page": final_state.get("page"),
            "properties_in_context": final_state.get("properties_in_context"),
            "focused_property_id": final_state.get("focused_property_id"),
            "focused_property_details": final_state.get("focused_property_details"),
            # Note: We don't send back session_id or session_memory,
            # as the frontend already knows the ID and doesn't need the memory.
        }
        
        # 7. Send the structured response to the frontend
        return {
            "text_response": final_message.content,
            "properties": final_state.get("properties_for_ui", []),
            "session_state": response_session_state
        }
    except Exception as e:
        logger.error(f"An error occurred in the LangGraph agent orchestrator: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"An internal server error occurred: {e}")
