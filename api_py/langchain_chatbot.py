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

# --- Dual-Model Architecture ---
llm_router = ChatGroq(temperature=0, model_name="llama-3.1-8b-instant", api_key=GROQ_API_KEY)
llm_generator = ChatGroq(temperature=0, model_name="llama-3.3-70b-versatile", api_key=GROQ_API_KEY)

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

# --- Helper Functions for Formatting ---
def format_property_summary(properties: List[Dict[str, Any]]) -> str:
    """Formats a list of properties into a concise summary."""
    if not properties:
        return "No properties found."
    
    summary_lines = []
    for prop in properties:
        price = f"₹{prop.get('price'):,}" if prop.get('price') else "Price on request"
        summary_lines.append(
            f"ID: {prop.get('id')}, Title: {prop.get('title')}, Price: {price}, Location: {prop.get('location')}"
        )
    return "\n".join(summary_lines)

def format_property_details(details: Dict[str, Any]) -> str:
    """Formats detailed property information into a readable key-value sheet."""
    formatted_details = []
    # Filter out complex objects and lists for a cleaner summary
    simple_details = {k: v for k, v in details.items() if isinstance(v, (str, int, float, bool))}
    
    for key, value in simple_details.items():
        if value is not None and value != '':
            formatted_key = key.replace('_', ' ').title()
            formatted_details.append(f"{formatted_key}: {value}")
            
    # Add a specific field if it exists, like description
    if details.get('description'):
        formatted_details.append(f"Description: {details.get('description')}")
        
    return "\n".join(formatted_details)

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
            return "Error: No data found for this ID."
        
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
    focused_property_id: Optional[str]
    focused_property_details: Optional[Dict[str, Any]]
    page: int
    tool_choice: Optional[ToolChoice]
    tool_output: Optional[str]

# --- Agent Nodes ---
async def agent_router_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Agent Router ---")
    
    system_template = """You are an intelligent real estate assistant acting as a router. Your primary goal is to analyze the user's query and the conversation context, then decide which tool to use. Your reasoning must be precise.

    **Your Thought Process:**
    1.  **Analyze the User's Latest Query:** What is the user's specific intent? Are they starting a new search, asking about a specific property, or asking a general question?
    2.  **Review the Context:** Look at `focused_property_id` and `focused_property_details`. Do I already have the information needed to answer the question?
    3.  **Select the Correct Tool:** Based on the intent and context, choose one of the tools below.

    **TOOL DESCRIPTIONS & USAGE:**
    - `structured_property_search`: Use for NEW property searches with clear, filterable criteria (e.g., location, price, bedrooms).
    - `get_listing_details`: Use ONLY when the user asks for details about a specific property for the FIRST time in the conversation, and you DO NOT have the `focused_property_details` in your context.
    - `respond_to_user`: This is a critical tool for follow-up questions. Use it when the user asks a question about a property whose details are ALREADY in the `focused_property_details` context. This tool takes NO ARGUMENTS (`tool_input` must be null). It signals that the next step should be to generate a response from existing data.
    - `knowledge_web_search`: Use for general real estate questions (e.g., "what is stamp duty?", "how to negotiate a price?").
    - `full_text_property_search` / `semantic_property_search`: Use for broader, name-based or descriptive searches.

    **CRITICAL SCENARIOS & EXAMPLES (Follow these strictly):**

    **Scenario 1: First-time Inquiry About a Specific Property**
    - **Context:** `focused_property_details` is `null`.
    - **User Query:** "Tell me more about the first one."
    - **Your Action:** Identify the property's ID from `properties_in_context`.
    - **Your Output:** `tool_name='get_listing_details', tool_input={{'listing_id': 'valid-uuid-goes-here'}}`

    **Scenario 2: Follow-up Question When Details Are Already Loaded**
    - **Context:** `focused_property_id` is "some-uuid", and `focused_property_details` contains rich JSON data.
    - **User Query:** "How much is it completed?" or "Does it have a balcony?"
    - **Your Action:** Recognize that you already have the data to answer this.
    - **Your Output:** `tool_name='respond_to_user', tool_input=null`. This is MANDATORY. Do not call `get_listing_details` again.

    **Current Context:**
    {context}
    """
    
    context_data = {
        "properties_in_context": [{'id': p.get('id'), 'title': p.get('title')} for p in state.get('properties', [])],
        "current_session_page": state.get('page', 1),
        "last_search_criteria": state.get('last_search_criteria'),
        "focused_property_id": state.get('focused_property_id'),
        "focused_property_details": "Available" if state.get('focused_property_details') else None
    }
    context_str = json.dumps(context_data, indent=2, default=str)
    
    parser = llm_router.with_structured_output(ToolChoice)
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("user", "{history}")
    ])
    chain = prompt | parser
    
    history_str = "\n".join([f"{m.type}: {m.content}" for m in state["messages"]])
    
    tool_choice = await chain.ainvoke({"history": history_str, "context": context_str})
    
    logger.info(f"Agent chose tool: {tool_choice.tool_name} with input: {tool_choice.tool_input}")
    
    focused_id = state.get("focused_property_id")
    if tool_choice.tool_name == "get_listing_details" and tool_choice.tool_input:
        focused_id = tool_choice.tool_input.get("listing_id")

    return {"tool_choice": tool_choice, "focused_property_id": focused_id}


async def tool_executor_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Tool Executor ---")
    tool_choice = state["tool_choice"]
    tool_to_call = tools.get(tool_choice.tool_name)
    
    if not tool_to_call:
        return {"tool_output": "Error: Invalid tool chosen."}

    tool_input = tool_choice.tool_input or {}
    
    if tool_choice.tool_name == "structured_property_search" and tool_input.get('page', 1) > 1:
         if state.get('last_search_criteria'):
            tool_input = {**state['last_search_criteria'], 'page': state['page'] + 1}

    output = await tool_to_call.ainvoke(tool_input)
    
    update = {"tool_output": output}
    
    if tool_choice.tool_name == "structured_property_search":
        update["last_search_criteria"] = tool_input
        update["page"] = tool_input.get('page', 1)
    
    if tool_choice.tool_name == "get_listing_details" and not output.startswith("Error"):
        try:
            details = json.loads(output)
            update["focused_property_details"] = details
        except json.JSONDecodeError:
            logger.warning("Failed to parse details from get_listing_details output.")

    return update


async def generate_response_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Generate Response ---")
    
    tool_choice = state.get("tool_choice")
    tool_output = state.get('tool_output')
    properties_for_ui = []
    formatted_context = "No new information."

    if tool_choice and tool_choice.tool_name == "respond_to_user" and state.get("focused_property_details"):
        formatted_context = f"You already have the following details for the property in focus. Use them to answer the user's latest question:\n{format_property_details(state['focused_property_details'])}"
    elif tool_choice and tool_output and not tool_output.startswith("Error"):
        try:
            parsed_output = json.loads(tool_output)
            if tool_choice.tool_name in ["structured_property_search", "full_text_property_search", "semantic_property_search"]:
                properties_for_ui = parsed_output
                formatted_context = f"Found {len(properties_for_ui)} properties:\n{format_property_summary(properties_for_ui)}"
            elif tool_choice.tool_name == "get_listing_details":
                formatted_context = f"Here are the newly fetched details for the requested property:\n{format_property_details(parsed_output)}"
            else:
                formatted_context = tool_output
        except (json.JSONDecodeError, TypeError):
            formatted_context = tool_output

    system_template = """You are a helpful and intelligent real estate assistant. Your job is to generate a final, user-facing response based on the latest information.

    **Your Thought Process:**
    1.  **Analyze the Context:** Read the "Latest Information" section. Does it contain new search results, specific property details, or an instruction to use data you already have?
    2.  **Address the User's Last Question:** Look at the "Conversation History" to understand the user's most recent query.
    3.  **Synthesize Your Answer:**
        - If the context provides a list of properties, summarize them and ask if the user wants more details on one.
        - If the context provides detailed information (either newly fetched or from memory), use it to directly and comprehensively answer the user's specific question.
        - If a tool returned an error or "not found", inform the user clearly and politely.
        - Always be concise, informative, and maintain a positive tone. Do not just dump raw JSON.
    """
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("user", "Conversation History:\n{history}\n\nLatest Information to Formulate Your Answer:\n{context}")
    ])
    chain = prompt | llm_generator
    
    history_str = "\n".join([f"{m.type}: {m.content}" for m in state["messages"]])
    
    response = await chain.ainvoke({"history": history_str, "context": formatted_context})
    
    final_messages = state["messages"] + [AIMessage(content=response.content)]
    
    return {
        "messages": final_messages, 
        "properties": properties_for_ui,
        "last_search_criteria": state.get("last_search_criteria"),
        "page": state.get("page"),
        "focused_property_id": state.get("focused_property_id"),
        "focused_property_details": state.get("focused_property_details")
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
        "focused_property_id": chat_request.session_state.get("focused_property_id"),
        "focused_property_details": chat_request.session_state.get("focused_property_details"),
        "page": chat_request.session_state.get("page", 1)
    }
    
    try:
        final_state = await app.ainvoke(initial_state, {"recursion_limit": 25})
        final_message = final_state['messages'][-1]
        
        properties_to_return = final_state.get("properties", [])
        
        response_session_state = {
            "page": final_state.get("page"),
            "last_search_criteria": final_state.get("last_search_criteria"),
            "focused_property_id": final_state.get("focused_property_id"),
            "focused_property_details": final_state.get("focused_property_details")
        }
        
        return {
            "text_response": final_message.content,
            "properties": properties_to_return,
            "session_state": response_session_state
        }
    except Exception as e:
        logger.error(f"An error occurred in the LangGraph agent orchestrator: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="An internal server error occurred.")

