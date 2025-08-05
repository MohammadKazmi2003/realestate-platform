# api/chat.py

import os
import json
import logging
import re
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ValidationError
from typing import List, Optional, Dict, Any
import groq
from supabase import create_client, Client
from decimal import Decimal
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv
load_dotenv()


# --- SETUP ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize clients
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

if not SUPABASE_URL or not SUPABASE_KEY or not GROQ_API_KEY:
    raise ValueError("Supabase and Groq API keys must be set.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
groq_client = groq.Client(api_key=GROQ_API_KEY)

# Load the embedding model ONCE when the server starts
try:
    embedding_model = SentenceTransformer('nomic-ai/nomic-embed-text-v1', trust_remote_code=True)
except Exception as e:
    logger.error(f"Failed to load SentenceTransformer model: {e}")
    embedding_model = None

# --- MODELS ---
class CustomEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal): return float(obj)
        return super(CustomEncoder, self).default(obj)

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[Message]
    session_state: Optional[Dict[str, Any]] = {}

class PropertyCard(BaseModel):
    id: str
    title: Optional[str] = None
    listing_type: Optional[str] = None
    image_url: Optional[str] = None
    price: Optional[float] = None
    location: Optional[str] = None
    bedrooms: Optional[int] = None
    page_link: Optional[str] = None

class ChatResponse(BaseModel):
    text_response: str
    properties: List[PropertyCard] = []
    session_state: Dict[str, Any]

# --- FASTAPI APP ---
app = FastAPI()

# --- FUNCTION SCHEMAS ---
FILTER_SEARCH_SCHEMA = {
    "name": "search_all_properties",
    "description": "Searches for properties using specific, concrete filters like location, price, or bedroom count.",
    "parameters": {
        "type": "object",
        "properties": {
            "p_location": {"type": "string", "description": "The city or area, e.g., 'Dubai Marina'"},
            "p_property_type": {"type": "string", "description": "e.g., 'apartment', 'villa'"},
            "p_min_price": {"type": "number"}, "p_max_price": {"type": "number"},
            "p_bedrooms": {"type": "integer"},
            "p_amenities": {"type": "array", "items": {"type": "string"}, "description": "Specific, tangible amenities like 'pool' or 'gym'."},
            "p_exclude_ids": {"type": "array", "items": {"type": "string"}, "description": "A list of property UUIDs to exclude from the search results."}
        },
    },
}

SEMANTIC_SEARCH_SCHEMA = {
    "name": "match_properties_semantic",
    "description": "Searches for properties based on descriptive, conceptual, or subjective user queries like 'a quiet place' or 'good for families'.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The user's original, natural language query text to be used for the semantic search."
            },
            "match_threshold": {"type": "number", "description": "Similarity threshold. A good default is 0.75."},
            "match_count": {"type": "integer", "description": "Number of properties to return. Default is 10."}
        },
        "required": ["query"],
    },
}

# --- SYSTEM PROMPT ---
SYSTEM_PROMPT = """
You are a state-of-the-art UAE real estate assistant. Your primary goal is to provide the most relevant properties to the user by intelligently choosing between two powerful search tools.

**TOOL SELECTION GUIDELINES:**

1.  **`search_all_properties` (FILTER-BASED):**
    * **USE WHEN:** The user provides specific, concrete criteria. This is your default tool for most queries.
    * **Examples:** "Show me 3 bed apartments in Dubai Marina", "villas under 5M with a pool", "properties in Downtown Dubai".
    * **Pagination:** If the user asks to "see more" or "show other options", you MUST call this tool again with the *exact same filters* as the previous turn, but you MUST also populate the `p_exclude_ids` parameter with the IDs of the properties you have already shown.

2.  **`match_properties_semantic` (SEMANTIC/VECTOR SEARCH):**
    * **USE WHEN:** The user's query is descriptive, subjective, or about the *feeling* or *concept* of a property.
    * **Examples:** "Find me a quiet place near the water", "a modern apartment with lots of light".
    * **IMPORTANT:** You must pass the user's original query text directly to the `query` parameter. The system will handle generating the embedding vector from this text. **DO NOT** attempt to create or guess the vector yourself.


**CONVERSATIONAL CONTEXT RULES:**

* **MAINTAIN CONTEXT:** If a user provides a follow-up, merge it with the previous filters. (e.g., "villas in Dubai" -> "with a pool").
* **RESET CONTEXT:** If a new query seems like a fresh start (e.g., it includes a new location AND a new property type), DISCARD the old filters and start a new search.
* **BEDROOMS:** Always extract just the number. "Studio" = 0.
* **RESPONSE:** After getting results, give a brief, friendly confirmation. DO NOT list properties in your text.
"""

@app.post("/api/chat", response_model=ChatResponse)
async def handle_chat(request: ChatRequest):
    logger.info(f"Received request: {request.messages[-1].content} with state: {request.session_state}")

    # --- FIX: Handle Chat Reset ---
    last_user_message = request.messages[-1].content.lower().strip()
    if last_user_message in ["clear", "reset", "start over", "new search"]:
        return ChatResponse(text_response="Of course, let's start a fresh search. What are you looking for?", properties=[], session_state={})

    # Prepare messages for the LLM
    current_filters_text = f"current_filters: {json.dumps(request.session_state)}"
    messages_for_api = [msg.dict() for msg in request.messages]
    messages_for_api[-1]['content'] = f"{current_filters_text}\n\nUser query: {messages_for_api[-1]['content']}"
    chat_history = [{"role": "system", "content": SYSTEM_PROMPT}] + messages_for_api
    
    try:
        response = groq_client.chat.completions.create(
            model="llama3-70b-8192",
            messages=chat_history,
            tools=[{"type": "function", "function": FILTER_SEARCH_SCHEMA}, {"type": "function", "function": SEMANTIC_SEARCH_SCHEMA}],
            tool_choice="auto",
        )
        message = response.choices[0].message
        tool_call = message.tool_calls[0] if message.tool_calls else None

        if not tool_call:
            return ChatResponse(text_response=message.content or "How can I assist you?", session_state=request.session_state)

        function_name = tool_call.function.name
        args = json.loads(tool_call.function.arguments)
        
        properties_found = []
        final_args = {}

        if function_name == 'search_all_properties':
            logger.info(f"Tool chosen: FILTER search with args: {args}")
            
            # --- FIX: Handle Pagination ("show more") ---
            if "show more" in last_user_message or "more options" in last_user_message:
                shown_ids = request.session_state.get('shown_ids', [])
                args['p_exclude_ids'] = shown_ids
            
            final_args = {**request.session_state, **args}
            
            # Sanitize bedrooms
            if 'p_bedrooms' in final_args:
                try:
                    final_args['p_bedrooms'] = int(final_args['p_bedrooms'])
                except (ValueError, TypeError):
                    del final_args['p_bedrooms']
            # 🚨 Only include 'p_exclude_ids' and 'p_amenities' if they are non-empty lists
            for key in ['p_exclude_ids', 'p_amenities']:
                if key in final_args:
                    if not isinstance(final_args[key], list) or not final_args[key]:
                        del final_args[key]
            logger.debug(f"Final args passed to RPC: {json.dumps(final_args, indent=2)}")

            db_response = supabase.rpc(function_name, final_args).execute()
            
        elif function_name == 'match_properties_semantic':
            logger.info(f"Tool chosen: SEMANTIC search with args: {args}")
            if not embedding_model:
                raise HTTPException(status_code=500, detail="Embedding model is not available.")

            # Get the raw query text from the LLM's tool call
            query_text = args.get("query")
            if not query_text:
                raise HTTPException(status_code=400, detail="Query text is required for semantic search.")

            # Generate the embedding on the backend
            embedding = embedding_model.encode(query_text).tolist()

            # Prepare the arguments for the Supabase RPC call
            final_args = {
                "query_embedding": embedding,
                "match_threshold": args.get('match_threshold', 0.75),
                "match_count": args.get('match_count', 10),
            }

            db_response = supabase.rpc('match_properties_semantic', final_args).execute()

        if hasattr(db_response, 'error') and db_response.error:
            logger.error(f"Supabase RPC Error: {db_response.error}")
            raise HTTPException(status_code=500, detail=f"Database error: {db_response.error.message}")

        properties_found = db_response.data or []
        logger.info(f"Found {len(properties_found)} properties.")
        
        # Update the list of shown property IDs in session state
        newly_shown_ids = [p['id'] for p in properties_found]
        all_shown_ids = list(set(request.session_state.get('shown_ids', []) + newly_shown_ids))
        final_args['shown_ids'] = all_shown_ids

        # Generate final response
                # Only pass count of properties to Groq to reduce payload size
        assistant_message_for_history = {
            "role": "assistant",
            "tool_calls": message.tool_calls
        }
        function_response_message = {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "name": function_name,
            "content": json.dumps({"result_count": len(properties_found)})
        }

        chat_history.append(assistant_message_for_history)
        chat_history.append(function_response_message)

        # Limit history size (system prompt + last 3 exchanges = safe)
        chat_history_trimmed = chat_history[:1] + chat_history[-6:]

        # Now send trimmed history to Groq
        final_response = groq_client.chat.completions.create(
            model="llama3-70b-8192",
            messages=chat_history_trimmed
        )


        # *** THIS IS THE TYPO FIX ***
        text_content = final_response.choices[0].message.content

        valid_properties = [PropertyCard(**p) for p in properties_found]
        
        # FIX: Remove the embedding before sending the state back to the client
        if 'query_embedding' in final_args:
            del final_args['query_embedding']

        return ChatResponse(
            text_response=text_content, 
            properties=valid_properties,
            session_state=final_args
        )

    except Exception as e:
        logger.error(f"An unexpected error occurred: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="An internal server error occurred.")

