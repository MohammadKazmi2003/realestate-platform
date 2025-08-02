# api/chat.py

import os
import json
import logging
import re
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ValidationError
from typing import List, Optional, Dict, Any
import groq
from supabase import create_client, Client
from decimal import Decimal

# --- SETUP ---
# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize clients
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

if not SUPABASE_URL or not SUPABASE_KEY or not GROQ_API_KEY:
    raise ValueError("Supabase and Groq API keys must be set in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
groq_client = groq.Client(api_key=GROQ_API_KEY)

# --- Custom JSON Encoder ---
class CustomEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(CustomEncoder, self).default(obj)

# --- MODELS ---

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[Message]

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

# --- FASTAPI APP ---
app = FastAPI()

# --- FUNCTION CALLING SCHEMA ---
DATABASE_FUNCTION_SCHEMA = {
    "name": "search_all_properties",
    "description": "Searches for properties and new projects based on user criteria.",
    "parameters": {
        "type": "object",
        "properties": {
            "p_location": {
                "type": "string",
                "description": "The city, community, or area to search in. Example: 'Dubai Marina'",
            },
            "p_min_price": {
                "type": "number",
                "description": "The minimum price in AED. Example: 1000000",
            },
            "p_max_price": {
                "type": "number",
                "description": "The maximum price in AED. Example: 2500000",
            },
            "p_bedrooms": {
                "type": "integer",
                "description": "The exact number of bedrooms required. Example: 3",
            },
        },
        "required": [],
    },
}

# --- SYSTEM PROMPT ---
SYSTEM_PROMPT = """
You are a friendly and expert UAE real estate assistant. Your goal is to help users find properties by converting their natural language queries into structured database searches.

1.  **Analyze the user's query** to understand their intent.
2.  **Use the `search_all_properties` function** to find relevant listings. You must call this function to get data.
3.  **Strictly adhere to the function's parameter schema.** Ensure all values are of the correct type (e.g., integer for bedrooms, number for price). For bedrooms, extract only the number (e.g., from "3 BHK", use `3`).
4.  If the user's query is ambiguous, **ask clarifying questions**.
5.  Once you have the search results, **present them clearly** to the user in a warm, conversational tone. Summarize the findings before showing the property cards.
6.  Always use the context from the chat history to handle follow-up questions.
"""

@app.post("/api/chat", response_model=ChatResponse)
async def handle_chat(request: ChatRequest):
    logger.info("Received request for /api/chat")
    chat_history = [{"role": "system", "content": SYSTEM_PROMPT}] + [msg.dict() for msg in request.messages]
    
    try:
        # --- Step 1: LLM Function Calling ---
        logger.info("Step 1: Calling LLM for function...")
        response = groq_client.chat.completions.create(
            model="llama3-70b-8192",
            messages=chat_history,
            tools=[{"type": "function", "function": DATABASE_FUNCTION_SCHEMA}],
            tool_choice="auto",
        )
        message = response.choices[0].message
        tool_call = message.tool_calls[0] if message.tool_calls else None

        if not tool_call:
            logger.info("LLM decided not to call a function. Returning direct response.")
            return ChatResponse(text_response=message.content or "How can I help you find a property?")

        # --- Step 2: Parse Arguments and Call Database ---
        logger.info("Step 2: Parsing arguments and calling database...")
        try:
            function_args = json.loads(tool_call.function.arguments)
        except json.JSONDecodeError:
            logger.error(f"LLM returned invalid JSON arguments: {tool_call.function.arguments}")
            return ChatResponse(text_response="I had a little trouble understanding that. Could you please rephrase?")

        # --- FIX: Data Sanitization Layer ---
        if 'p_bedrooms' in function_args and isinstance(function_args['p_bedrooms'], str):
            # Use regex to find the first number in a string like "3 BHK" or "Studio (0 beds)"
            match = re.search(r'\d+', function_args['p_bedrooms'])
            if match:
                function_args['p_bedrooms'] = int(match.group(0))
            else:
                # Handle cases like "Studio" where there might not be a number
                if 'studio' in function_args['p_bedrooms'].lower():
                    function_args['p_bedrooms'] = 0
                else:
                    del function_args['p_bedrooms'] # Remove if we can't parse it

        logger.info(f"Executing Supabase RPC 'search_all_properties' with sanitized args: {function_args}")
        db_response = supabase.rpc("search_all_properties", function_args).execute()
        
        if hasattr(db_response, 'error') and db_response.error:
            logger.error(f"Supabase RPC Error: {db_response.error.message}")
            raise HTTPException(status_code=500, detail=f"Database query failed: {db_response.error.message}")

        properties_found = db_response.data if db_response.data else []
        logger.info(f"Found {len(properties_found)} properties in the database.")

        # --- Step 3: Generate Final Conversational Response ---
        logger.info("Step 3: Calling LLM for final conversational response...")
        function_response_message = {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "name": "search_all_properties",
            "content": json.dumps(properties_found, cls=CustomEncoder),
        }
        
        chat_history.append(message)
        chat_history.append(function_response_message)

        final_response = groq_client.chat.completions.create(model="llama3-70b-8192", messages=chat_history)
        text_content = final_response.choices[0].message.content

        # --- Step 4: Validate and Format Final Response ---
        logger.info("Step 4: Validating and formatting the final response.")
        valid_properties = []
        for p in properties_found:
            try:
                valid_properties.append(PropertyCard(**p))
            except ValidationError as e:
                logger.warning(f"Skipping a property due to validation error: {e}")

        return ChatResponse(text_response=text_content, properties=valid_properties)

    except Exception as e:
        logger.error(f"An unexpected error occurred in /api/chat: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="An internal server error occurred.")
