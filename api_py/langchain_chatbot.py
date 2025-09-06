import os
import asyncio
import logging
from typing import List, Dict, Any, Optional
from uuid import UUID
import re

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser, StrOutputParser
from langchain_groq import ChatGroq
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from supabase import create_client, Client
# FIX: Use the correct, modern import paths
from langchain_community.tools.tavily_search import TavilySearchResults
from langchain_huggingface import HuggingFaceEmbeddings

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
    # FIX: Use a dedicated, reliable local embeddings client with the required flag.
    # This is the industry best practice for speed, efficiency, and cost-effectiveness.
    embedding_client = HuggingFaceEmbeddings(
        model_name="nomic-ai/nomic-embed-text-v1",
        model_kwargs={'trust_remote_code': True}
    )
except Exception as e:
    logger.error(f"Failed to initialize clients: {e}")
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
    location: Optional[str] = Field(None, description="The city or area to search in, inferred from landmarks if necessary (e.g., 'near Burj Khalifa' should become 'Downtown Dubai').")
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
    Use for specific property searches with clear criteria like location, price, or bedroom count.
    """
    valid_exclude_ids = [str(UUID(item)) for item in exclude_ids if item]
    logger.info(f"Executing structured search with criteria: {{location: {location}, type: {property_type}, max_price: {max_price}}}")
    
    # FIX: Removed the unsupported p_property_name parameter to align with the DB schema
    response = supabase_client.rpc("search_all_properties", {
        "p_location": location, "p_property_type": property_type,
        "p_min_price": min_price, "p_max_price": max_price,
        "p_bedrooms": bedrooms, "p_amenities": None,
        "p_exclude_ids": valid_exclude_ids,
    }).execute()
    return response.data or []

@tool
async def full_text_property_search(query: str, exclude_ids: List[str] = []) -> List[Dict[str, Any]]:
    """
    Use this tool when the user is searching for a specific property by its name or title.
    """
    valid_exclude_ids = [str(UUID(item)) for item in exclude_ids if item]
    logger.info(f"Executing FTS for query: '{query}'")
    
    response = supabase_client.rpc("text_search_properties", {
        "p_query": query,
        "p_exclude_ids": valid_exclude_ids,
    }).execute()
    return response.data or []

@tool
async def semantic_property_search(query: str, exclude_ids: List[str] = []) -> List[Dict[str, Any]]:
    """
    Use for vague, descriptive searches like 'a villa with a sea view' or 'something modern'.
    """
    valid_exclude_ids = [str(UUID(item)) for item in exclude_ids if item]
    logger.info(f"Executing semantic search for query: '{query}'")
    
    query_embedding = embedding_client.embed_query(query)
    
    # FIX: Removed unsupported p_exclude_ids to match the database schema hint
    response = supabase_client.rpc("match_property_chunks", {
        "query_embedding": query_embedding,
        "match_threshold": 0.78, 
        "match_count": 10,
    }).execute()
    
    if response.data and valid_exclude_ids:
        return [item for item in response.data if item.get('id') not in valid_exclude_ids]
    
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
    # FIX: Added 'property_name_search' to the intent router
    router_prompt = ChatPromptTemplate.from_template(
        """Analyze the last user message and classify the intent. Categories: 'structured_search', 'property_name_search', 'semantic_search', 'knowledge_search', 'follow_up_question'.
        - 'property_name_search': User gives the specific name of a property (e.g., "more about Bugatti Residences").
        - 'structured_search': User gives criteria like location or price (e.g., "villas in Dubai under 2M").
        - 'semantic_search': User uses descriptive terms (e.g., "a place with a sea view").
        - 'knowledge_search': User asks a general question.
        - 'follow_up_question': User asks about a property already shown.

        Conversation: {history}
        Classification:"""
    )
    chain = router_prompt | llm | StrOutputParser()
    return await chain.ainvoke({"history": chat_history})

# FIX: Criteria extractor is now context-aware and handles complex queries
async def get_structured_criteria(history: List[Dict[str, Any]]) -> dict:
    parser = JsonOutputParser(pydantic_object=SearchCriteria)
    
    few_shot_prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content="You are a data extraction expert. Your job is to analyze a conversation and extract the final, consolidated search criteria into a raw JSON object. Do not include any other text. Infer criteria from previous messages if the last message is a continuation (e.g., 'show me more'). Resolve landmarks to locations (e.g., 'near Burj Khalifa' is 'Downtown Dubai')."),
        HumanMessage(content="show me 3 bedroom villas in dubai under 2.5 million AED"),
        AIMessage(content='{"location": "Dubai", "property_type": "villa", "min_price": 0, "max_price": 2500000, "bedrooms": 3}'),
        HumanMessage(content="""[{'role': 'user', 'content': 'apartments near Burj Khalifa'}, {'role': 'assistant', 'content': 'I found 10 properties...'}, {'role': 'user', 'content': 'show me more options'}]"""),
        AIMessage(content='{"location": "Downtown Dubai", "property_type": "apartment", "min_price": null, "max_price": null, "bedrooms": null}'),
        HumanMessage(content=f"Extract the consolidated JSON search criteria from this conversation history:\n\n{history}\n\n{parser.get_format_instructions()}"),
    ])
    
    chain = few_shot_prompt | llm | parser
    return await chain.ainvoke({})

# FIX: RAG retriever is now context-aware
async def handle_follow_up_question(history: List[Message], query: str) -> str:
    logger.info(f"Handling follow-up question: '{query}'")
    
    properties_in_context = [p for msg in reversed(history) if msg.properties for p in msg.properties]
    
    if not properties_in_context:
        return "I'm sorry, I don't have any properties in our current conversation to discuss."

    property_titles = [p.get('title', '') for p in properties_in_context]
    last_assistant_message = history[-2].content if len(history) > 1 else ""

    retriever_prompt = ChatPromptTemplate.from_template(
        """Your job is to identify the single most relevant property from the list based on the user's question and the immediate context. Return ONLY the name of the property.

        CONTEXT: The assistant just said: "{last_assistant_message}"
        USER QUESTION: "{question}"
        AVAILABLE PROPERTY TITLES:
        - {titles}
        
        Most Relevant Title:"""
    )
    
    retriever_chain = retriever_prompt | llm | StrOutputParser()
    retrieved_title = await retriever_chain.ainvoke({
        "question": query, "titles": "\n- ".join(property_titles), "last_assistant_message": last_assistant_message
    })
    
    logger.info(f"RAG Retriever identified '{retrieved_title}' as the most relevant property.")
    
    target_property = next((p for p in properties_in_context if p.get('title') and re.search(re.escape(retrieved_title.strip()), p.get('title'), re.IGNORECASE)), None)
            
    if not target_property:
        return "I'm sorry, I couldn't find the specific property you're asking about in our conversation history. Could you please clarify?"

    context_for_rag = f"Property Name: {target_property.get('title', 'N/A')}\nDetails: {target_property.get('description', 'No description available.')}\nPrice: {target_property.get('price', 'N/A')}"

    generator_prompt = ChatPromptTemplate.from_template(
        """You are a helpful real estate assistant. Use ONLY the provided property details below to answer the user's question. Respond in a concise, natural, and helpful tone.
        
        Property Details: {context}
        User's Question: {question}
        Answer:"""
    )
    
    generator_chain = generator_prompt | llm | StrOutputParser()
    return await generator_chain.ainvoke({"context": context_for_rag, "question": query})


# --- Main Orchestrator Endpoint ---

@router.post("/api/chat_langchain")
async def chat_langchain_endpoint(chat_request: ChatRequest):
    messages = [Message(**msg.dict()) for msg in chat_request.messages]
    history_for_llms = [{"role": msg.role, "content": msg.content} for msg in messages]
    latest_query = history_for_llms[-1]['content']
    exclude_ids = chat_request.exclude_ids_context

    intent = await get_intent(history_for_llms)
    logger.info(f"Detected user intent: '{intent}'")

    properties_to_return = []
    text_response = ""

    try:
        if "property_name_search" in intent:
            properties_to_return = await full_text_property_search.ainvoke({"query": latest_query, "exclude_ids": exclude_ids})
            text_response = f"I found {len(properties_to_return)} properties matching that name:" if properties_to_return else f"I couldn't find any properties named '{latest_query}'."

        elif "structured_search" in intent:
            criteria = await get_structured_criteria(history_for_llms)
            properties_to_return = await structured_property_search.ainvoke({**criteria, "exclude_ids": exclude_ids})
            count = len(properties_to_return)
            text_response = f"I found {count} properties matching your criteria." if count > 0 else "I couldn't find any properties matching your criteria."

        elif "semantic_search" in intent:
            properties_to_return = await semantic_property_search.ainvoke({"query": latest_query, "exclude_ids": exclude_ids})
            text_response = f"Based on your description, I found {len(properties_to_return)} properties you might like:" if properties_to_return else "I couldn't find any properties that fit that description."
        
        elif "knowledge_search" in intent:
            text_response = await knowledge_web_search.ainvoke(latest_query)
        
        elif "follow_up_question" in intent:
            text_response = await handle_follow_up_question(messages, latest_query)

        else:
            text_response = await knowledge_web_search.ainvoke(latest_query)

        if properties_to_return:
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

