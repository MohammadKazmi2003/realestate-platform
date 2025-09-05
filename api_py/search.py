import os
import re
import logging
from typing import List, Dict, Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client
from sentence_transformers import SentenceTransformer

# Import the router from the langchain chatbot file
from api_py.langchain_chatbot import router as langchain_router

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
    embedding_model = SentenceTransformer('nomic-ai/nomic-embed-text-v1', trust_remote_code=True)
except Exception as e:
    logger.error(f"Failed to initialize clients or models: {e}")
    raise

# --- Main FastAPI App Initialization ---
# This is now the single entry point for the entire Python backend.
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Include the LangChain router ---
# This line makes all routes from langchain_chatbot.py (like /api/chat) available through this main app.
app.include_router(langchain_router)


# --- Pydantic Models ---
class SearchRequest(BaseModel):
    query: str
    exclude_ids: List[str] = []

class SearchResponse(BaseModel):
    properties: List[Dict[str, Any]]
    new_exclude_ids: List[str]

# --- Helper Functions ---
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

# --- API Endpoint for Fast Search ---
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
        embedding = embedding_model.encode(request.query).tolist()
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

