import os
import asyncio
import logging
import json
from typing import List, Dict, Any, Optional, TypedDict, Literal
from uuid import UUID

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, AIMessage, BaseMessage
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

# --- Pydantic Models for Data Structure ---
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
    tool_input: Optional[Dict[str, Any]] = Field(None, description="The input parameters for the chosen tool. Must be null for 'respond_to_user'.")

# --- Helper Functions for Token-Efficient Formatting ---
def format_property_summary(properties: List[Dict[str, Any]]) -> str:
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
    """
    Formats the complete property details JSON into a comprehensive, readable, 
    and AI-friendly summary. It preserves all critical information.
    """
    if not details:
        return "No details available for this property."

    output_lines = []

    def format_value(val):
        """Helper to format individual values for readability."""
        if val is None or val == '':
            return None
        if isinstance(val, bool):
            return "Yes" if val else "No"
        if isinstance(val, (int, float)):
            if val > 10000:
                return f"₹{val:,}"
            return str(val)
        return str(val)

    # --- Process All Fields Dynamically ---
    for key, value in details.items():
        # Skip empty fields and internal IDs/links that are not useful for the LLM
        if value is None or value == '' or key in ['id', 'page_link', 'images', 'listing_type', 'user_id', 'created_at', 'profiles', 'property_media', 'project_media']:
            continue

        formatted_key = key.replace('_', ' ').title()

        # Handle lists (e.g., features, amenities, faqs)
        if isinstance(value, list) and value:
            # Handle lists of dicts first
            if all(isinstance(item, dict) for item in value):
                # Specifically for FAQs
                if key == 'faqs' and all('question' in item and 'answer' in item for item in value):
                    faq_lines = [f"\n{formatted_key}:"]
                    for item in value:
                        q = item.get('question')
                        a = item.get('answer')
                        if q and a:
                            faq_lines.append(f"  Q: {q}\n  A: {a}")
                    if len(faq_lines) > 1:
                        output_lines.append("\n".join(faq_lines))
                # Generic handler for other lists of dicts (like amenities)
                else:
                    items = [item.get('name') for item in value if item.get('name')]
                    if items:
                        output_lines.append(f"{formatted_key}: {', '.join(items)}")

            # Handle simple lists of strings/numbers (like property_types for projects)
            elif all(isinstance(item, (str, int, float)) for item in value):
                items = [format_value(item) for item in value if item]
                if items:
                    output_lines.append(f"{formatted_key}: {', '.join(items)}")
        
        # Handle dictionary/object values (e.g., status, price_range)
        elif isinstance(value, dict) and value:
            dict_lines = [f"\n{formatted_key}:"]
            for sub_key, sub_val in value.items():
                formatted_sub_val = format_value(sub_val)
                if formatted_sub_val:
                    dict_lines.append(f"  {sub_key.replace('_', ' ').title()}: {formatted_sub_val}")
            if len(dict_lines) > 1:
                output_lines.append("\n".join(dict_lines))

        # Handle simple key-value pairs (strings, numbers, bools)
        else:
            formatted_val = format_value(value)
            if formatted_val:
                # Add extra spacing for long text fields
                if key in ['description', 'master_plan_description', 'description_html']:
                    output_lines.append(f"\n{formatted_key}:\n{formatted_val}")
                else:
                    output_lines.append(f"{formatted_key}: {formatted_val}")

    return "\n".join(output_lines)


# --- Asynchronous Tools Definition ---
@tool
async def structured_property_search(
    location: Optional[str] = None, property_type: Optional[str] = None,
    min_price: Optional[float] = None, max_price: Optional[float] = None,
    bedrooms: Optional[int] = None, page: int = 1
) -> str:
    """Searches for properties using specific, structured criteria like location, price, and number of bedrooms."""
    logger.info(f"TOOL CALL: Structured search with criteria: {{location: {location}, property_type: {property_type}, page: {page}}}")
    params = { 
        "p_location": location, "p_property_type": property_type, "p_min_price": min_price, 
        "p_max_price": max_price, "p_bedrooms": bedrooms, "p_amenities": None, 
        "p_exclude_ids": [], "p_page": page, "p_limit": 10 
    }
    response = await asyncio.to_thread(supabase_client.rpc("search_all_properties", params).execute)
    return json.dumps(response.data, indent=2) if response.data else "No properties found matching your criteria."

@tool
async def full_text_property_search(query: str) -> str:
    """Performs a full-text search for properties by their name or title."""
    logger.info(f"TOOL CALL: Full-text search for query: '{query}'")
    params = {"p_query": query, "p_exclude_ids": []}
    response = await asyncio.to_thread(supabase_client.rpc("text_search_properties", params).execute)
    return json.dumps(response.data, indent=2) if response.data else f"No properties found for '{query}'."

@tool
async def semantic_property_search(query: str) -> str:
    """Searches for properties based on a descriptive or conceptual query using vector embeddings."""
    logger.info(f"TOOL CALL: Semantic search for query: '{query}'")
    query_embedding = embedding_engine.embed_query(query)
    params = {"query_embedding": query_embedding, "match_threshold": 0.78, "match_count": 10}
    response = await asyncio.to_thread(supabase_client.rpc("match_property_chunks", params).execute)
    return json.dumps(response.data, indent=2) if response.data else "No properties found for that description."

@tool
async def get_listing_details(listing_id: str) -> str:
    """Fetches all available details for a single property or project using its unique ID."""
    logger.info(f"TOOL CALL: Fetching full details for listing ID: {listing_id}")
    if not listing_id:
        return "Error: A valid listing_id must be provided."
    try:
        UUID(listing_id)
        response = await asyncio.to_thread(supabase_client.rpc('get_listing_details', {'p_listing_id': listing_id}).execute)
        
        if not response.data:
            return "Error: No data found for this ID."
        
        details_object = response.data[0] if isinstance(response.data, list) else response.data
        return json.dumps(details_object, indent=2)

    except (ValueError, TypeError):
        return f"Error: The provided ID '{listing_id}' is not a valid UUID. Please find the correct ID from the context."
    except Exception as e:
        logger.error(f"Error in get_listing_details tool: {e}", exc_info=True)
        return f"An error occurred while fetching details. Error: {e}"

@tool
async def knowledge_web_search(query: str) -> str:
    """Searches the web to answer general real estate questions that do not involve property listings."""
    logger.info(f"TOOL CALL: Knowledge search for query: '{query}'")
    tavily_tool = TavilySearchResults(max_results=3, api_key=TAVILY_API_KEY)
    results = await tavily_tool.ainvoke(query)
    return "\n".join([res["content"] for res in results])

# --- Tool Registry ---
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
    properties_for_ui: Optional[List[Dict[str, Any]]]
    last_search_criteria: Optional[Dict[str, Any]]
    focused_property_id: Optional[str]
    focused_property_details: Optional[Dict[str, Any]]
    page: int
    tool_choice: Optional[ToolChoice]
    tool_output: Optional[str]

# --- Agent Nodes ---
async def agent_router_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Agent Router ---")
    system_template = """You are a highly intelligent and methodical real estate assistant. Your primary goal is to analyze the user's query and the conversation context to select the correct tool and parameters.

    **Your Core Reasoning Process:**
    1.  **Analyze User Intent:** Determine the user's primary goal. Is it a new search, a follow-up on a specific property, a request for more results (pagination), or a general question?
    2.  **Contextual Check:** Before doing anything else, check the `properties_in_context` list. If the user mentions a property by name (e.g., "Azure Heights") or by position ("the first one," "the 3rd property"), you MUST first check if that property exists in the context list.
    3.  **Tool Selection Logic:**
        - **If it's a follow-up on a property IN CONTEXT:** Use `get_listing_details` with the correct ID from the context.
        - **If it's a follow-up on a property NOT IN CONTEXT:** This is a new search. Use `full_text_property_search`.
        - **If it's a pagination request ("show more," "next"):** Check for `last_search_criteria`. If it exists, use `structured_property_search`, reusing the criteria and incrementing the page number (`current_session_page + 1`).
        - **If it's a new, filtered search:** Use `structured_property_search`.
        - **If you already have the details:** For follow-up questions about a property whose details are already in `focused_property_details`, use `respond_to_user`.
        - **For general questions:** Use `knowledge_web_search`.

    **CRITICAL SCENARIOS & EXAMPLES (Follow these strictly):**

    **Scenario 1: Follow-up by Name (In Context)**
    - **Context:** `properties_in_context` includes a property titled "Azure Heights".
    - **User Query:** "Tell me more about Azure Heights."
    - **Your Action:** You see "Azure Heights" is in the context. You will extract its ID.
    - **Your Output:** `tool_name='get_listing_details', tool_input={{'listing_id': 'id_of_azure_heights'}}`

    **Scenario 2: Follow-up by Name (NOT in Context)**
    - **Context:** "Azure Heights" is NOT in `properties_in_context`.
    - **User Query:** "Tell me more about Azure Heights."
    - **Your Action:** The property is not in your immediate context, so you must perform a new search.
    - **Your Output:** `tool_name='full_text_property_search', tool_input={{'query': 'Azure Heights'}}`

    **Scenario 3: Pagination Request**
    - **Context:** `last_search_criteria` exists, `current_session_page` is 1.
    - **User Query:** "show me more options"
    - **Your Action:** This is a clear pagination request. You MUST reuse `last_search_criteria` and set the `page` to `current_session_page + 1`.
    - **Your Output:** `tool_name='structured_property_search', tool_input={{...last_search_criteria, 'page': 2}}`

    **Current Context:**
    {context}
    """
    context_data = {
        "properties_in_context": [{'id': p.get('id'), 'title': p.get('title')} for p in state.get('properties', [])],
        "current_session_page": state.get('page', 1),
        "last_search_criteria": state.get('last_search_criteria'),
        "focused_property_id": state.get('focused_property_id'),
        "focused_property_details_available": "Yes" if state.get('focused_property_details') else "No"
    }
    context_str = json.dumps(context_data, indent=2, default=str)
    
    parser = llm_router.with_structured_output(ToolChoice)
    prompt = ChatPromptTemplate.from_messages([("system", system_template), ("user", "{history}")])
    chain = prompt | parser
    
    history_str = "\n".join([f"{m.type}: {m.content}" for m in state["messages"]])
    tool_choice = await chain.ainvoke({"history": history_str, "context": context_str})
    
    logger.info(f"LLM chose tool: {tool_choice.tool_name} with input: {tool_choice.tool_input}")
    
    focused_id = state.get("focused_property_id")
    if tool_choice.tool_name == "get_listing_details" and tool_choice.tool_input:
        new_focused_id = tool_choice.tool_input.get("listing_id")
        if new_focused_id:
            focused_id = new_focused_id

    return {"tool_choice": tool_choice, "focused_property_id": focused_id}

async def tool_executor_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Tool Executor ---")
    tool_choice = state.get("tool_choice")
    if not tool_choice: return {"tool_output": "Error: No tool was chosen."}
    tool_to_call = tools.get(tool_choice.tool_name)
    if not tool_to_call: return {"tool_output": f"Error: Invalid tool '{tool_choice.tool_name}' chosen."}

    tool_input = tool_choice.tool_input or {}
    output = await tool_to_call.ainvoke(tool_input)
    update: Dict[str, Any] = {"tool_output": output}
    
    if tool_choice.tool_name == "structured_property_search":
        update["last_search_criteria"] = {k:v for k,v in tool_input.items() if k != 'page'}
        update["page"] = tool_input.get('page', 1)
    
    if tool_choice.tool_name == "get_listing_details" and not output.startswith("Error"):
        try:
            update["focused_property_details"] = json.loads(output)
        except json.JSONDecodeError:
            logger.warning("Failed to parse details from get_listing_details output.")
    return update

async def generate_response_node(state: AgentState) -> Dict[str, Any]:
    logger.info("--- NODE: Generate Response ---")
    tool_choice = state.get("tool_choice")
    tool_output = state.get('tool_output')
    
    properties_for_ui = []
    persistent_properties = state.get('properties', [])
    formatted_context = "I couldn't find any information about that. Could you please rephrase your request?"

    if tool_choice and tool_choice.tool_name == "respond_to_user" and state.get("focused_property_details"):
        formatted_context = f"You already have the following details for the property in focus. Use them to answer the user's latest question:\n{format_property_details(state['focused_property_details'])}"
    
    elif tool_choice and tool_output:
        if tool_output.startswith("Error"):
            formatted_context = tool_output
        else:
            try:
                parsed_output = json.loads(tool_output)
                is_new_search = tool_choice.tool_name in ["structured_property_search", "full_text_property_search", "semantic_property_search"]
                
                if is_new_search:
                    properties_for_ui = parsed_output
                    if tool_choice.tool_input and tool_choice.tool_input.get('page', 1) == 1:
                        persistent_properties = parsed_output
                    else: 
                        persistent_properties.extend(parsed_output)

                    if properties_for_ui:
                        formatted_context = f"Found {len(properties_for_ui)} more properties:\n{format_property_summary(properties_for_ui)}"
                    else:
                        formatted_context = "I couldn't find any properties matching that description. Would you like to try a different search?"
                
                elif tool_choice.tool_name == "get_listing_details":
                    # When getting details, format them for the LLM
                    formatted_context = f"Here are the newly fetched details for the requested property:\n{format_property_details(parsed_output)}"
                
                else: # knowledge_web_search
                    formatted_context = tool_output
            except (json.JSONDecodeError, TypeError):
                formatted_context = tool_output # Fallback for non-JSON text from knowledge search

    # --- INSPECTION LOGGING ---
    # Log the exact context being sent to the final generator LLM.
    logger.info(f"--- CONTEXT FOR GENERATOR ---\n{formatted_context}")
    # --- END INSPECTION LOGGING ---

    system_template = """You are a helpful and intelligent real estate assistant. Your job is to generate a final, user-facing response based on the information provided in the 'Latest Information' section.

    **CRITICAL INSTRUCTION:** You MUST use the information provided in the 'Latest Information to Formulate Your Answer' section to answer the user's question. Do not rely on prior knowledge or make assumptions. If the answer exists in the provided text (like in an FAQ section), you must extract it and provide it to the user. If the information is not present, then you can say you do not have that specific detail.
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
        "properties": persistent_properties,
        "properties_for_ui": properties_for_ui,
        "last_search_criteria": state.get("last_search_criteria"),
        "page": state.get("page"),
        "focused_property_id": state.get("focused_property_id"),
        "focused_property_details": state.get("focused_property_details")
    }

def should_call_tool(state: AgentState) -> Literal["tool_executor_node", "generate_response_node"]:
    if state.get("tool_choice") and state["tool_choice"].tool_name != "respond_to_user":
        return "tool_executor_node"
    return "generate_response_node"

# --- Graph Definition ---
def build_graph():
    workflow = StateGraph(AgentState)
    workflow.add_node("agent_router_node", agent_router_node)
    workflow.add_node("tool_executor_node", tool_executor_node)
    workflow.add_node("generate_response_node", generate_response_node)
    workflow.set_entry_point("agent_router_node")
    workflow.add_conditional_edges("agent_router_node", should_call_tool, {"tool_executor_node": "tool_executor_node", "generate_response_node": "generate_response_node"})
    workflow.add_edge("tool_executor_node", "generate_response_node")
    workflow.add_edge("generate_response_node", END)
    return workflow.compile()

langgraph_app = build_graph()

# --- Main FastAPI Endpoint ---
@router.post("/api/chat_langchain")
async def chat_langchain_endpoint(chat_request: ChatRequest):
    latest_query = chat_request.messages[-1].content.lower().strip()
    if latest_query in ['close', 'exit', 'goodbye', 'bye', "that's all", "thank you"]:
        return {"text_response": "You're welcome! Let me know if you need anything else.", "properties": [], "session_state": {}}
        
    messages: List[BaseMessage] = []
    properties_from_session = chat_request.session_state.get("properties", [])
    for msg in chat_request.messages:
        if msg.role == 'user':
            messages.append(HumanMessage(content=msg.content))
        else:
            messages.append(AIMessage(content=msg.content))

    initial_state: AgentState = {
        "messages": messages,
        "properties": properties_from_session,
        "properties_for_ui": None,
        "last_search_criteria": chat_request.session_state.get("last_search_criteria"),
        "focused_property_id": chat_request.session_state.get("focused_property_id"),
        "focused_property_details": chat_request.session_state.get("focused_property_details"),
        "page": chat_request.session_state.get("page", 1),
        "tool_choice": None,
        "tool_output": None,
    }
    
    try:
        final_state = await langgraph_app.ainvoke(initial_state, {"recursion_limit": 10})
        final_message = final_state['messages'][-1]
        
        response_session_state = {
            "page": final_state.get("page"),
            "last_search_criteria": final_state.get("last_search_criteria"),
            "focused_property_id": final_state.get("focused_property_id"),
            "focused_property_details": final_state.get("focused_property_details"),
            "properties": final_state.get("properties")
        }
        
        return {
            "text_response": final_message.content,
            "properties": final_state.get("properties_for_ui", []),
            "session_state": response_session_state
        }
    except Exception as e:
        logger.error(f"An error occurred in the LangGraph agent orchestrator: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="An internal server error occurred.")
#studio Entry point
app = langgraph_app