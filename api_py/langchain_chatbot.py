import os
import asyncio
import logging
from typing import List, Dict, Any, Optional
from uuid import UUID
import re

import groq
from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
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

router = APIRouter()

# --- Pydantic Models ---
class Message(BaseModel):
    role: str
    content: str
    properties: Optional[List[Dict[str, Any]]] = None

class ChatRequest(BaseModel):
    messages: List[Message]
    exclude_ids_context: List[str] = []

class SearchCriteria(BaseModel):
    location: Optional[str] = Field(None, description="The city or area to search in.")
    property_type: Optional[str] = Field(None, description="The type of property, e.g., 'apartment' or 'villa'.")
    min_price: Optional[float] = Field(None, description="The minimum price, defaulting to 0 if not specified.")
    max_price: Optional[float] = Field(None, description="The maximum price.")
    bedrooms: Optional[int] = Field(None, description="The number of bedrooms.")

# --- LLM Definition ---
llm = ChatGroq(temperature=0, model_name="llama-3.1-8b-instant", api_key=GROQ_API_KEY)

# --- Tool Definitions ---

@tool
async def structured_property_search(
    location: Optional[str] = None,
    property_type: Optional[str] = None,
    min_price: Optional[float] = 0, # Default min_price
    max_price: Optional[float] = None,
    bedrooms: Optional[int] = None,
    exclude_ids: List[str] = [],
) -> List[Dict[str, Any]]:
    """
    Use for specific property searches with clear criteria like location, price, or bedroom count.
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
    Use for vague, descriptive searches like 'a villa with a sea view' or 'something modern'.
    """
    valid_exclude_ids = [str(UUID(item)) for item in exclude_ids if item]
    logger.info(f"Executing semantic search for query: '{query}' excluding {len(valid_exclude_ids)} IDs.")
    
    # This requires a model that provides embeddings, nomic-embed-text is a good choice.
    embedding_response = llm.client.embed(model="nomic-embed-text", input=query)
    
    response = supabase_client.rpc("match_property_chunks", {
        "query_embedding": embedding_response.data[0].embedding,
        "match_threshold": 0.78, 
        "match_count": 10,
        "p_exclude_ids": valid_exclude_ids
    }).execute()
    
    return response.data or []

@tool
async def knowledge_web_search(query: str) -> str:
    """
    Use for general real estate questions that are not property searches.
    """
    logger.info(f"Executing knowledge search for query: '{query}'")
    tavily_tool = TavilySearchResults(max_results=3, api_key=TAVILY_API_KEY)
    results = await tavily_tool.ainvoke(query)
    return "\n".join([res["content"] for res in results])


# --- Core Logic Components ---

async def get_intent(chat_history: List[Dict[str, Any]]) -> str:
    """
    Classifies the user's intent to route to the correct tool or RAG pipeline.
    """
    router_prompt = ChatPromptTemplate.from_template(
        """Analyze the last user message in the context of the conversation history and classify the user's intent.
        
        Categories:
        - 'structured_search': User provides specific criteria (location, price, bedrooms, property type).
        - 'semantic_search': User uses descriptive language (e.g., 'sea view', 'modern', 'quiet').
        - 'knowledge_search': User asks a general question about real estate.
        - 'follow_up_question': User asks a specific question about a property already mentioned in the chat.

        Conversation History:
        {history}
        
        Based on the LAST message, what is the single most likely intent?
        Classification:"""
    )
    chain = router_prompt | llm | StrOutputParser()
    return await chain.ainvoke({"history": chat_history})

async def get_structured_criteria(query: str) -> dict:
    """
    Extracts structured search criteria from a natural language query using few-shot examples.
    """
    parser = JsonOutputParser(pydantic_object=SearchCriteria)
    
    few_shot_prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content="You are a data extraction expert. Your only job is to extract search criteria from a user's query and output it as a raw JSON object. Do not include any other text, explanations, or markdown. You must extract all available criteria."),
        HumanMessage(content="show me apartments in 'Dubai Marina'"),
        AIMessage(content='{"location": "Dubai Marina", "property_type": "apartment", "min_price": null, "max_price": null, "bedrooms": null}'),
        HumanMessage(content="find me 3 bedroom villas under 2.5 million AED"),
        AIMessage(content='{"location": null, "property_type": "villa", "min_price": 0, "max_price": 2500000, "bedrooms": 3}'),
        HumanMessage(content="what about something between 1M and 1.5M?"),
        AIMessage(content='{"location": null, "property_type": null, "min_price": 1000000, "max_price": 1500000, "bedrooms": null}'),
        HumanMessage(content=f"Extract JSON from this query: {query}\n\n{parser.get_format_instructions()}"),
    ])
    
    chain = few_shot_prompt | llm | parser
    return await chain.ainvoke({})

# *** FIX: Implemented a context-aware RAG pipeline ***
async def handle_follow_up_question(history: List[Message], query: str) -> str:
    """
    Uses a two-stage RAG process to answer a specific question about a property.
    """
    logger.info(f"Handling follow-up question: '{query}'")
    
    properties_in_context = []
    for msg in reversed(history):
        if msg.properties:
            properties_in_context.extend(msg.properties)
    
    if not properties_in_context:
        return "I'm sorry, I don't have any properties in our current conversation to discuss. How about we search for some?"

    # --- Stage 1: Context-Aware Retrieval ---
    property_titles = [p.get('title', '') for p in properties_in_context]
    
    # Get the last assistant message for context
    last_assistant_message = ""
    if len(history) > 1:
        # The last message is the user's, the one before is the assistant's
        last_assistant_message = history[-2].content

    retriever_prompt = ChatPromptTemplate.from_template(
        """Your job is to identify the single most relevant property from the list based on the user's question and the immediate context of the conversation.
        Return ONLY the name of the property.

        CONVERSATION CONTEXT:
        The user was just told: "{last_assistant_message}"

        USER QUESTION: "{question}"
        
        AVAILABLE PROPERTY TITLES:
        - {titles}
        
        Most Relevant Title based on the question and context:"""
    )
    
    retriever_chain = retriever_prompt | llm | StrOutputParser()
    retrieved_title = await retriever_chain.ainvoke({
        "question": query, 
        "titles": "\n- ".join(property_titles),
        "last_assistant_message": last_assistant_message
    })
    
    logger.info(f"RAG Retriever identified '{retrieved_title}' as the most relevant property.")
    
    # Find the full details for the retrieved property
    target_property = None
    for prop in properties_in_context:
        # Use a more flexible check to find the property
        if prop.get('title') and re.search(re.escape(retrieved_title.strip()), prop.get('title'), re.IGNORECASE):
            target_property = prop
            break
            
    if not target_property:
        return "I'm sorry, I couldn't find the specific property you're asking about in our conversation history. Could you please clarify?"

    # --- Stage 2: Augmented Generation ---
    context_for_rag = f"Property Name: {target_property.get('title', 'N/A')}\nDetails: {target_property.get('description', 'No description available.')}\nPrice: {target_property.get('price', 'N/A')}"

    generator_prompt = ChatPromptTemplate.from_template(
        """You are a helpful real estate assistant. Use ONLY the provided property details below to answer the user's question.
        Respond in a concise, natural, and helpful tone.
        
        Property Details:
        ---
        {context}
        ---
        
        User's Question: {question}
        
        Answer:"""
    )
    
    generator_chain = generator_prompt | llm | StrOutputParser()
    return await generator_chain.ainvoke({"context": context_for_rag, "question": query})


# --- Main Orchestrator Endpoint ---

@router.post("/api/chat_langchain")
async def chat_langchain_endpoint(chat_request: ChatRequest):
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
            criteria = await get_structured_criteria(latest_query)
            properties_to_return = await structured_property_search.ainvoke({**criteria, "exclude_ids": exclude_ids})
            text_response = f"I found {len(properties_to_return)} properties matching your criteria:" if properties_to_return else "I couldn't find any properties matching your criteria."

        elif "semantic_search" in intent:
            properties_to_return = await semantic_property_search.ainvoke({"query": latest_query, "exclude_ids": exclude_ids})
            text_response = f"Based on your description, I found {len(properties_to_return)} properties you might like:" if properties_to_return else "I couldn't find any properties that fit that description."
        
        elif "knowledge_search" in intent:
            text_response = await knowledge_web_search.ainvoke(latest_query)
        
        elif "follow_up_question" in intent:
            text_response = await handle_follow_up_question(messages, latest_query)

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

