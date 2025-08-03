# api/chat.py

import os
import json
import logging
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import groq
from supabase import create_client, Client
from decimal import Decimal
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv
# --- FIX: Import the specific exception for better error handling ---
from postgrest.exceptions import APIError

load_dotenv()

# --- SETUP (remains the same) ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not SUPABASE_URL or not SUPABASE_KEY or not GROQ_API_KEY:
    raise ValueError("Supabase and Groq API keys must be set.")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
groq_client = groq.Client(api_key=GROQ_API_KEY)
try:
    embedding_model = SentenceTransformer('nomic-ai/nomic-embed-text-v1', trust_remote_code=True)
except Exception as e:
    logger.error(f"Failed to load SentenceTransformer model: {e}")
    embedding_model = None

# --- MODELS (remains the same) ---
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

app = FastAPI()

# --- FUNCTION SCHEMAS (remains the same) ---
FILTER_SEARCH_SCHEMA = {
    "name": "search_all_properties",
    "description": "Searches for properties using specific, concrete filters like location, price, or bedroom count.",
    "parameters": {
        "type": "object",
        "properties": {
            "p_location": {"type": "string"}, "p_property_type": {"type": "string"},
            "p_min_price": {"type": "number"}, "p_max_price": {"type": "number"},
            "p_bedrooms": {"type": "integer"},
            "p_amenities": {"type": "array", "items": {"type": "string"}},
        },
    },
}
SEMANTIC_SEARCH_SCHEMA = {
    "name": "match_properties_semantic",
    "description": "Use for abstract, conceptual, or lifestyle-based queries like 'peaceful homes' or 'good for families'.",
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "The user's original, natural language query text."}},
        "required": ["query"],
    },
}

# --- MASTER SYSTEM PROMPT (remains the same) ---
SYSTEM_PROMPT = """
You are "Prophet", a world-class, friendly, and conversational real estate assistant for the UAE. Your goal is to help users find their dream property.

**YOUR BEHAVIOR:**
1.  **Analyze Intent:** First, understand the user's intent. Are they providing specific filters (like "3 bedrooms in Dubai Marina"), or are they describing a feeling or lifestyle (like "a quiet place with a nice view")?
2.  **Tool Selection:**
    * For specific filters, always use the `search_all_properties` tool.
    * For abstract or lifestyle queries, always use the `match_properties_semantic` tool.
3.  **Conversational Memory:** The user's current search criteria are provided. Use this to handle follow-up questions.
    * If they add a filter ("with a pool"), call `search_all_properties` with BOTH the old criteria and the new amenity.
    * If they change a filter ("in Abu Dhabi instead"), call `search_all_properties` replacing the old location with the new one.
    * If they ask for "more options", call `search_all_properties` with the exact same criteria again.
4.  **Summarize Results:** After the system finds properties, you will be given the results. Your final job is to present these results to the user in a helpful, human-friendly summary. Start with a confirmation, mention the number of properties found, and highlight 1-2 key properties with their title, price, and location. ALWAYS provide links.
"""

# --- FINAL RESPONSE PROMPT (remains the same) ---
FINAL_RESPONSE_PROMPT_TEMPLATE = """
You are "Prophet", a helpful real estate assistant. A search has been performed based on the user's criteria.

**User's final query:** "{user_query}"
**Search criteria used:** {search_criteria}
**Properties found:**
{properties_summary}

Your task is to craft a friendly, conversational, and informative response to the user.
- Start with a confirmation like "Certainly!" or "I've found some great options for you."
- State the number of properties found.
- If properties were found, briefly highlight 1-2 of the best matches, mentioning their title, price, and location.
- Ensure your tone is helpful and professional, not robotic.
- ALWAYS include the `page_link` for the properties you mention.
- If no properties were found, say so gracefully and suggest broadening the search criteria.
"""

def summarize_properties_for_llm(properties: List[Dict]) -> str:
    if not properties:
        return "No properties found."
    summary = ""
    for p in properties[:5]: # Summarize the top 5
        summary += f"- Title: {p.get('title', 'N/A')}, Price: {p.get('price', 'N/A')}, Location: {p.get('location', 'N/A')}, Link: {p.get('page_link', 'N/A')}\n"
    return summary

@app.post("/api/chat", response_model=ChatResponse)
async def handle_chat(request: ChatRequest):
    current_search_params = request.session_state or {}
    last_user_message = request.messages[-1].content
    logger.info(f"Received message: '{last_user_message}' with current state: {current_search_params}")

    if last_user_message.lower().strip() in ["clear", "reset", "start over", "new search", "start afresh"]:
        return ChatResponse(text_response="Let's start fresh! What are you looking for?", properties=[], session_state={})

    messages_for_planning = [{"role": "system", "content": SYSTEM_PROMPT}]
    if current_search_params:
        context_message = f"Current search criteria: {json.dumps(current_search_params)}"
        messages_for_planning.append({"role": "system", "content": context_message})
    messages_for_planning.extend([msg.dict() for msg in request.messages])

    try:
        response = groq_client.chat.completions.create(
            model="llama3-70b-8192", messages=messages_for_planning,
            tools=[{"type": "function", "function": FILTER_SEARCH_SCHEMA}, {"type": "function", "function": SEMANTIC_SEARCH_SCHEMA}],
            tool_choice="auto", temperature=0
        )
        response_message = response.choices[0].message
        tool_calls = response_message.tool_calls

        if not tool_calls:
            return ChatResponse(text_response=response_message.content or "How can I help you further?", properties=[], session_state=current_search_params)

        tool_call = tool_calls[0]
        function_name = tool_call.function.name
        new_args = json.loads(tool_call.function.arguments)
        
        properties_found = []
        db_response_data = []
        
        if function_name == 'search_all_properties':
            logger.info(f"Tool: FILTER search, New args: {new_args}")
            is_show_more = "more" in last_user_message.lower() or "options" in last_user_message.lower()
            if not is_show_more:
                current_search_params.update(new_args)
            
            valid_db_keys = {'p_location', 'p_property_type', 'p_min_price', 'p_max_price', 'p_bedrooms', 'p_amenities'}
            final_args_for_db = {key: current_search_params[key] for key in valid_db_keys if key in current_search_params and current_search_params[key]}
            if current_search_params.get('shown_ids'):
                final_args_for_db['p_exclude_ids'] = current_search_params['shown_ids']
            
            logger.info(f"Executing 'search_all_properties' with: {final_args_for_db}")
            db_response = supabase.rpc("search_all_properties", final_args_for_db).execute()

        elif function_name == 'match_properties_semantic':
            # --- FIX: Corrected variable name from 'args' to 'new_args' ---
            logger.info(f"Tool: SEMANTIC search, Query: {new_args.get('query')}")
            if not embedding_model: raise HTTPException(500, "Embedding model not available.")
            
            query_text = new_args.get("query")
            embedding = embedding_model.encode(query_text).tolist()
            
            chunk_response = supabase.rpc('match_property_chunks', {
                "query_embedding": embedding,
                "match_threshold": 0.75,
                "match_count": 10
            }).execute()

            matched_ids = [item['id'] for item in chunk_response.data]
            if not matched_ids:
                db_response_data = []
            else:
                db_response = supabase.from_('unified_listings_view').select('*').in_('id', matched_ids).execute()
            
            current_search_params = {"semantic_query": query_text}

        # --- FIX: Correct error handling for Supabase client ---
        # The new client raises an APIError on failure, so we wrap calls in a try/except block.
        # A successful call's response object does not have an `.error` attribute.
        properties_found = db_response.data

        logger.info(f"Found {len(properties_found)} properties.")
        
        newly_shown_ids = [p['id'] for p in properties_found]
        all_shown_ids = list(set(current_search_params.get('shown_ids', []) + newly_shown_ids))
        current_search_params['shown_ids'] = all_shown_ids

        properties_summary = summarize_properties_for_llm(properties_found)
        final_prompt = FINAL_RESPONSE_PROMPT_TEMPLATE.format(
            user_query=last_user_message,
            search_criteria=json.dumps(current_search_params),
            properties_summary=properties_summary
        )
        
        final_response_completion = groq_client.chat.completions.create(
            model="llama3-70b-8192",
            messages=[{"role": "system", "content": final_prompt}],
            temperature=0.2
        )
        text_content = final_response_completion.choices[0].message.content

        valid_properties = [PropertyCard(**p) for p in properties_found]

        return ChatResponse(
            text_response=text_content, 
            properties=valid_properties,
            session_state=current_search_params
        )

    except APIError as e:
        logger.error(f"Supabase API Error: {e.message}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Database error: {e.message}")
    except Exception as e:
        logger.error(f"An unexpected error occurred: {e}", exc_info=True) 
        raise HTTPException(status_code=500, detail=f"An internal server error occurred: {str(e)}")
