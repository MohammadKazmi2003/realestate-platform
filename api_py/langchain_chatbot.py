import os
import asyncio
import logging
from typing import List, Dict, Any, Optional
from uuid import UUID

import groq
from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser, StrOutputParser
from langchain_groq import ChatGroq
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from supabase import create_client, Client
from langchain_community.tools.tavily_search import TavilySearchResults

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
    raise ValueError("One or more required environment variables are missing (Supabase, Groq, Tavily).")

try:
    supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
except Exception as e:
    logger.error(f"Failed to initialize Supabase client: {e}")
    raise

# This router will be imported by the main FastAPI app in search.py
router = APIRouter()

# --- Pydantic Models ---
class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[Message]
    exclude_ids_context: List[str] = []

class SearchCriteria(BaseModel):
    location: Optional[str] = Field(None, description="The city or area to search in.")
    property_type: Optional[str] = Field(None, description="The type of property, e.g., 'apartment' or 'villa'.")
    min_price: Optional[float] = Field(None, description="The minimum price.")
    max_price: Optional[float] = Field(None, description="The maximum price.")
    bedrooms: Optional[int] = Field(None, description="The number of bedrooms.")

# --- LLM Definition ---
llm = ChatGroq(temperature=0, model_name="llama-3.1-8b-instant", api_key=GROQ_API_KEY)

# --- Tool Definitions ---

@tool
async def structured_property_search(
    location: Optional[str] = None,
    property_type: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    bedrooms: Optional[int] = None,
    exclude_ids: List[str] = [],
) -> List[Dict[str, Any]]:
    """
    Use this tool for specific, structured property searches with clear criteria like location, price, or bedroom count.
    """
    valid_exclude_ids = [str(UUID(item)) for item in exclude_ids if item]
    logger.info(f"Executing structured search with criteria: {{location: {location}, type: {property_type}, max_price: {max_price}}} excluding {len(valid_exclude_ids)} IDs.")
    
    response = supabase_client.rpc("search_all_properties", {
        "p_location": location, "p_property_type": property_type,
        "p_min_price": min_price, "p_max_price": max_price,
        "p_bedrooms": bedrooms, "p_amenities": None,
        "p_exclude_ids": valid_exclude_ids,
    }).execute()

    return response.data or []

@tool
async def semantic_property_search(query: str, exclude_ids: List[str] = []) -> List[Dict[str, Any]]:
    """
    Use this tool for vague, descriptive, or feature-based searches like 'a villa with a sea view' or 'something modern'.
    """
    valid_exclude_ids = [str(UUID(item)) for item in exclude_ids if item]
    logger.info(f"Executing semantic search for query: '{query}' excluding {len(valid_exclude_ids)} IDs.")
    
    response = supabase_client.rpc("match_property_chunks", {
        "query_embedding": llm.client.embed(model="nomic-embed-text-v1", input=query).data[0].embedding,
        "match_threshold": 0.78, 
        "match_count": 10,
        "p_exclude_ids": valid_exclude_ids
    }).execute()
    
    return response.data or []

@tool
async def knowledge_web_search(query: str) -> str:
    """
    Use this for general real estate questions that are not property searches, like 'What is ROI?' or 'How does a mortgage work?'.
    """
    logger.info(f"Executing knowledge search for query: '{query}'")
    tavily_tool = TavilySearchResults(max_results=3, api_key=TAVILY_API_KEY)
    results = await tavily_tool.ainvoke(query)
    return "\n".join([res["content"] for res in results])


# --- Stage 1: Intent Router ---

async def get_intent(chat_history: List[Dict[str, str]]):
    """
    Classifies the user's intent to route to the correct tool.
    """
    router_prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content="You are an expert at routing user queries. Classify the latest user query into one of the following categories: 'structured_search', 'semantic_search', 'knowledge_search', or 'follow_up_question'."),
        HumanMessage(content=f"""
            Analyze the latest user message in the context of the conversation history.
            
            - If the user provides specific criteria (location, price, bedrooms, property type), classify as 'structured_search'. Example: "show me villas in dubai under 2m".
            - If the user uses descriptive language (e.g., 'sea view', 'modern', 'quiet neighborhood'), classify as 'semantic_search'. Example: "find me something with a nice garden".
            - If the user asks a general knowledge question about real estate (e.g., ROI, fees, market trends), classify as 'knowledge_search'. Example: "what are the closing costs?".
            - If the user asks a specific question about a property already mentioned in the chat, classify as 'follow_up_question'. Example: "what is the price of the first one?".

            Conversation History:
            {chat_history}
            
            Based on the last message, what is the user's intent? Classification:
        """),
    ])
    chain = router_prompt | llm | StrOutputParser()
    return await chain.ainvoke({})


# --- Stage 2: Orchestrator Endpoint ---

@router.post("/api/chat_langchain")
async def chat_langchain_endpoint(chat_request: ChatRequest):
    """
    Orchestrates the conversation by routing to the correct tool based on user intent.
    This is the new intelligent endpoint.
    """
    messages = chat_request.messages
    history_for_llms = [{"role": msg.role, "content": msg.content} for msg in messages]
    latest_query = messages[-1].content
    exclude_ids = chat_request.exclude_ids_context

    intent = await get_intent(history_for_llms)
    logger.info(f"Detected user intent: '{intent}'")

    properties_to_return = []
    text_response = ""

    try:
        if "structured_search" in intent:
            parser = JsonOutputParser(pydantic_object=SearchCriteria)
            # *** FIX: Added a clear example and stricter instructions to the prompt. ***
            prompt = ChatPromptTemplate.from_messages([
                SystemMessage(content="You are a data extraction expert. Your sole purpose is to extract structured search criteria from a user's query and output it as a raw JSON object. You MUST NOT include any other text, explanations, or markdown formatting. You MUST extract all available criteria including location, property_type, min_price, max_price, and bedrooms."),
                HumanMessage(content=f"""
                Extract the JSON search criteria from the following query.
                Example Query: "show me 3 bedroom apartments in 'Dubai Marina' between 1M and 2.5M AED"
                Example Output: {{"location": "Dubai Marina", "property_type": "apartment", "min_price": 1000000, "max_price": 2500000, "bedrooms": 3}}

                Query: {latest_query}
                
                {parser.get_format_instructions()}
                """),
            ])
            criteria_chain = prompt | llm | parser
            criteria = await criteria_chain.ainvoke({})
            search_results = await structured_property_search.ainvoke({**criteria, "exclude_ids": exclude_ids})
            properties_to_return = search_results
            text_response = f"I found {len(properties_to_return)} properties matching your criteria:" if properties_to_return else "I couldn't find any properties matching your criteria."

        elif "semantic_search" in intent:
            search_results = await semantic_property_search.ainvoke({"query": latest_query, "exclude_ids": exclude_ids})
            properties_to_return = search_results
            text_response = f"Based on your description, I found {len(properties_to_return)} properties you might like:" if properties_to_return else "I couldn't find any properties that fit that description."
        
        elif "knowledge_search" in intent:
            text_response = await knowledge_web_search.ainvoke(latest_query)
        
        elif "follow_up_question" in intent:
            prompt = ChatPromptTemplate.from_messages([
                SystemMessage(content="You are a helpful assistant. Answer the user's question based on the provided conversation context, which may include details of properties already shown."),
                HumanMessage(content=f"Conversation: {history_for_llms}\n\nQuestion: {latest_query}\n\nAnswer:")
            ])
            chain = prompt | llm | StrOutputParser()
            text_response = await chain.ainvoke({})

        else: # Fallback for unclear intent
            text_response = await knowledge_web_search.ainvoke(latest_query)

        # Retrieve full data for any property IDs found from structured or semantic search
        if properties_to_return and isinstance(properties_to_return, list) and len(properties_to_return) > 0 and isinstance(properties_to_return[0], dict):
             property_ids = [p.get("id") for p in properties_to_return if p.get("id")]
             if property_ids:
                 full_data_result = supabase_client.from_("unified_listings_view").select("*").in_("id", property_ids).execute()
                 properties_to_return = full_data_result.data or []

        return {
            "text_response": text_response,
            "properties": properties_to_return,
            "session_state": {} 
        }

    except Exception as e:
        logger.error(f"An error occurred in the chat orchestrator: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="An internal server error occurred.")

