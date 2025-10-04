import os
import asyncio
import logging
from typing import List, Dict, Any, Optional, TypedDict, Literal
from uuid import UUID
import re
import json

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage, BaseMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_groq import ChatGroq
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from supabase import create_client, Client
from langchain_community.tools.tavily_search import TavilySearchResults
from langgraph.graph import StateGraph, END
from api_py.shared_embedding import embedding_engine

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
    raise ValueError("One or more required environment variables are missing.")

try:
    supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
except Exception as e:
    logger.error(f"Failed to initialize clients: {e}")
    raise

router = APIRouter()

# --- FIX: Consolidated to a single, powerful LLM for all agent tasks ---
llm = ChatGroq(temperature=0, model_name="llama-3.3-70b-versatile", api_key=GROQ_API_KEY)


# --- Pydantic Models ---
class Message(BaseModel):
    role: str
    content: str
    properties: Optional[List[Dict[str, Any]]] = None

class ChatRequest(BaseModel):
    messages: List[Message]
    session_state: Dict[str, Any] = {}

class ToolChoice(BaseModel):
    tool_name: Literal[
        "structured_property_search", "full_text_property_search", "semantic_property_search",
        "get_listing_details", "knowledge_web_search", "respond_to_user"
    ] = Field(..., description="The tool to use based on the user's query.")
    tool_input: Optional[Dict[str, Any]] = Field(None, description="The input parameters for the chosen tool.")

# --- Asynchronous Tools ---
@tool
async def structured_property_search(
    location: Optional[str] = None, property_type: Optional[str] = None,
    min_price: Optional[float] = None, max_price: Optional[float] = None,
    bedrooms: Optional[int] = None, page: int = 1
) -> str:
    """Searches for properties with structured criteria."""
    logger.info(f"TOOL CALL: Structured search with criteria: {{location: {location}, property_type: {property_type}, page: {page}}}")
    params = { "p_location": location, "p_property_type": property_type, "p_min_price": min_price, "p_max_price": max_price, "p_bedrooms": bedrooms, "p_amenities": None, "p_exclude_ids": [], "p_page": page, "p_limit": 10 }
    response = await asyncio.to_thread(supabase_client.rpc("search_all_properties", params).execute)
    return json.dumps(response.data, indent=2) if response.data else "No properties found matching your criteria."

@tool
async def full_text_property_search(query: str) -> str:
    """Searches for a property by its name."""
    logger.info(f"TOOL CALL: Full-text search for query: '{query}'")
    params = {"p_query": query, "p_exclude_ids": []}
    response = await asyncio.to_thread(supabase_client.rpc("text_search_properties", params).execute)
    return json.dumps(response.data, indent=2) if response.data else f"No properties found for '{query}'."

@tool
async def semantic_property_search(query: str) -> str:
    """Searches for properties based on descriptive text."""
    logger.info(f"TOOL CALL: Semantic search for query: '{query}'")
    query_embedding = embedding_engine.embed_query(query)
    params = {"query_embedding": query_embedding, "match_threshold": 0.78, "match_count": 10}
    response = await asyncio.to_thread(supabase_client.rpc("match_property_chunks", params).execute)
    return json.dumps(response.data, indent=2) if response.data else "No properties found for that description."

@tool
async def get_listing_details(listing_id: str) -> str:
    """Fetches full details for a listing."""
    logger.info(f"TOOL CALL: Fetching full details for listing ID: {listing_id}")
    try:
        UUID(listing_id)
        response = await asyncio.to_thread(supabase_client.rpc('get_listing_details', {'p_listing_id': listing_id}).execute)
        
        if not response.data:
            return "Error: No data was found for this ID in the database."

        details_object = response.data[0] if isinstance(response.data, list) else response.data
        return json.dumps(details_object, indent=2)

    except (ValueError, TypeError):
        return f"Error: The provided ID '{listing_id}' is not a valid UUID. Please provide the correct ID from the context."
    except Exception as e:
        logger.error(f"Error in get_listing_details_tool: {e}", exc_info=True)
        return f"An error occurred while fetching details. Please check the system logs. Error: {e}"

@tool
async def knowledge_web_search(query: str) -> str:
    """Searches the web for general real estate questions."""
    logger.info(f"TOOL CALL: Knowledge search for query: '{query}'")
    tavily_tool = TavilySearchResults(max_results=3, api_key=TAVILY_API_KEY)
    results = await tavily_tool.ainvoke(query)
    return "\n".join([res["content"] for res in results])

tools = {
    "structured_property_search": structured_property_search,
    "full_text_property_search": full_text_property_search,
    "semantic_property_search": semantic_property_search,
    "get_listing_details": get_listing_details,
    "knowledge_web_search": knowledge_web_search,
}

# --- LangGraph State Definition ---
class AgentState(TypedDict):
    messages: List[BaseMessage]
    properties: List[Dict[str, Any]]
    last_search_criteria: Optional[Dict[str, Any]]
    page: int
    tool_choice: Optional[ToolChoice]
    tool_output: Optional[str]

# --- Agent Nodes ---
async def agent_router_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Agent Router ---")
    
    system_template = """You are an intelligent real estate assistant responsible for routing user requests to the correct tool.
    Based on the conversation history and current context, you must decide which tool to call next.

    **DATABASE SCHEMA & CONSTRAINTS:**
    - The `property_type` parameter for `structured_property_search` MUST be one of the following exact, case-sensitive values: 'Villa', 'Apartment', 'Land', 'Commercial'.
    - You MUST normalize user input to match these values (e.g., "villas" or "Villas" becomes "Villa").

    **TOOL CHOICES:**
    - `structured_property_search`: For new searches with clear criteria.
    - `full_text_property_search`: For searches for a specific property by its proper name.
    - `semantic_property_search`: For vague, descriptive searches.
    - `get_listing_details`: For follow-up questions about a property already shown.
    - `knowledge_web_search`: For general questions NOT about finding a property.
    - `respond_to_user`: If no tool is needed or if a tool has just been successfully used.

    **CRITICAL INSTRUCTIONS FOR FOLLOW-UPS:**
    1.  When the user asks about a property using ordinal references (e.g., "the second one"), you MUST look at the `properties_in_context` list.
    2.  Identify the correct property from that list based on its position (index).
    3.  Extract its `id` and use that as the `listing_id` for the `get_listing_details` tool.
    4.  DO NOT pass the property's title as the ID.

    **CRITICAL INSTRUCTIONS FOR PAGINATION:**
    - For "show more" requests, choose `structured_property_search`, use the `last_search_criteria`, and increment the `page` number.

    **Current Context:**
    {context}
    """
    
    context_data = {
        "properties_in_context": [{'id': p.get('id'), 'title': p.get('title')} for p in state.get('properties', [])],
        "current_session_page": state.get('page', 1),
        "last_search_criteria": state.get('last_search_criteria')
    }
    context_str = json.dumps(context_data, indent=2)
    
    parser = llm.with_structured_output(ToolChoice)
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("user", "{history}")
    ])
    chain = prompt | parser
    
    history_str = "\n".join([f"{m.type}: {m.content}" for m in state["messages"]])
    
    tool_choice = await chain.ainvoke({"history": history_str, "context": context_str})
    
    logger.info(f"Agent chose tool: {tool_choice.tool_name} with input: {tool_choice.tool_input}")
    return {"tool_choice": tool_choice}

async def tool_executor_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Tool Executor ---")
    tool_choice = state["tool_choice"]
    tool_to_call = tools.get(tool_choice.tool_name)
    if tool_to_call:
        tool_input = tool_choice.tool_input or {}
        
        if tool_choice.tool_name == "structured_property_search" and tool_input.get('page', 1) > 1:
             if state.get('last_search_criteria'):
                tool_input = {**state['last_search_criteria'], 'page': state['page'] + 1}

        output = await tool_to_call.ainvoke(tool_input)
        
        # FIX: Correctly persist state across ALL tool calls.
        if tool_choice.tool_name == "structured_property_search":
            return {"tool_output": output, "last_search_criteria": tool_input, "page": tool_input.get('page', 1)}
        else:
            # Preserve the previous search context during non-search tool calls
            return {"tool_output": output, "last_search_criteria": state.get("last_search_criteria"), "page": state.get("page")}
            
    return {"tool_output": "Error: Invalid tool chosen."}

async def generate_response_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Generate Response ---")
    
    tool_choice = state.get("tool_choice")
    tool_output = state.get('tool_output')
    properties_for_ui = []

    if tool_choice:
        search_tools = ["structured_property_search", "full_text_property_search", "semantic_property_search"]
        if tool_choice.tool_name in search_tools and tool_output and not tool_output.startswith("Error"):
            try:
                properties_for_ui = json.loads(tool_output)
            except (json.JSONDecodeError, TypeError):
                pass

    system_template = """You are a helpful and intelligent real estate assistant. Your job is to generate a final, user-facing response.
    - If a search tool returned a list of properties, inform the user how many you found.
    - If the `get_listing_details` tool returned detailed information, use it to comprehensively answer the user's specific question.
    - If a tool returned an error or "not found", inform the user clearly and politely.
    - If you are just responding to a greeting or chat, continue the conversation naturally.
    - Be concise, informative, and maintain a positive tone. Do not just dump raw JSON.
    """
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("user", "Conversation History:\n{history}\n\nLatest Tool Output to inform your answer:\n{tool_output}")
    ])
    chain = prompt | llm
    
    history_str = "\n".join([f"{m.type}: {m.content}" for m in state["messages"]])
    tool_output_str = tool_output or 'No new information.'
    
    response = await chain.ainvoke({"history": history_str, "tool_output": tool_output_str})
    
    final_messages = state["messages"] + [AIMessage(content=response.content)]
    
    return {
        "messages": final_messages, 
        "properties": properties_for_ui,
        "last_search_criteria": state.get("last_search_criteria"),
        "page": state.get("page")
    }

def should_call_tool(state: AgentState) -> str:
    return "tool_executor_node" if state.get("tool_choice") and state["tool_choice"].tool_name != "respond_to_user" else "generate_response_node"

# --- Graph Definition ---
def build_graph():
    workflow = StateGraph(AgentState)
    workflow.add_node("agent_router_node", agent_router_node)
    workflow.add_node("tool_executor_node", tool_executor_node)
    workflow.add_node("generate_response_node", generate_response_node)
    
    workflow.set_entry_point("agent_router_node")
    
    workflow.add_conditional_edges("agent_router_node", should_call_tool, {
        "tool_executor_node": "tool_executor_node", 
        "generate_response_node": "generate_response_node"
    })
    workflow.add_edge("tool_executor_node", "generate_response_node")
    workflow.add_edge("generate_response_node", END)
    
    return workflow.compile()

app = build_graph()

# --- Main FastAPI Endpoint ---
@router.post("/api/chat_langchain")
async def chat_langchain_endpoint(chat_request: ChatRequest):
    latest_query = chat_request.messages[-1].content.lower().strip()
    if latest_query in ['close', 'exit', 'goodbye', 'bye', "that's all"]:
        return {"text_response": "You're welcome!", "properties": [], "session_state": {}}
        
    messages = []
    for msg in chat_request.messages:
        if msg.role == 'user':
            messages.append(HumanMessage(content=msg.content))
        else:
            content = msg.content
            if msg.properties:
                content += f"\n\n[Context: You have already shown the user {len(msg.properties)} properties.]"
            messages.append(AIMessage(content=content))

    initial_state: AgentState = {
        "messages": messages,
        "properties": [p for m in chat_request.messages if m.properties for p in m.properties],
        "last_search_criteria": chat_request.session_state.get("last_search_criteria"),
        "page": chat_request.session_state.get("page", 1)
    }
    
    try:
        final_state = await app.ainvoke(initial_state, {"recursion_limit": 25})
        final_message = final_state['messages'][-1]
        
        properties_to_return = final_state.get("properties", [])
        
        response_session_state = {
            "page": final_state.get("page"),
            "last_search_criteria": final_state.get("last_search_criteria"),
        }
        
        return {
            "text_response": final_message.content,
            "properties": properties_to_return,
            "session_state": response_session_state
        }
    except Exception as e:
        logger.error(f"An error occurred in the LangGraph agent orchestrator: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="An internal server error occurred.")

