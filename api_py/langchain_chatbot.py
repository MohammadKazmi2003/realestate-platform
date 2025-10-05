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
    """Formats detailed property information into a comprehensive, readable summary for the LLM."""
    if not details:
        return "No details available."

    output_lines = []
    simple_keys = [
        'title', 'price', 'bedrooms', 'bathrooms', 'area_sqft', 'property_type', 'location', 'status'
    ]
    for key in simple_keys:
        value = details.get(key)
        if value is not None and value != '':
            formatted_key = key.replace('_', ' ').title()
            if key == 'price' and isinstance(value, (int, float)):
                 value = f"₹{value:,}"
            output_lines.append(f"{formatted_key}: {value}")

    list_keys = ['features', 'amenities']
    for key in list_keys:
        value = details.get(key)
        if isinstance(value, list) and value:
            items = [str(item) for item in value if item]
            if items:
                formatted_key = key.replace('_', ' ').title()
                output_lines.append(f"{formatted_key}: {', '.join(items)}")

    text_keys = ['description', 'master_plan_description']
    for key in text_keys:
        value = details.get(key)
        if value and isinstance(value, str):
            formatted_key = key.replace('_', ' ').title()
            output_lines.append(f"\n{formatted_key}:\n{value}")

    faq_data = details.get('faq')
    if faq_data and isinstance(faq_data, list):
        faq_lines = ["\nFAQ:"]
        for item in faq_data:
            if isinstance(item, dict) and 'question' in item and 'answer' in item:
                q = item.get('question')
                a = item.get('answer')
                if q and a:
                    faq_lines.append(f"Q: {q}\nA: {a}")
        if len(faq_lines) > 1:
            output_lines.append("\n".join(faq_lines))

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
    system_template = """You are an intelligent real estate assistant acting as a router. Your primary goal is to analyze the user's query and the conversation context, then decide which tool to use. Your reasoning must be precise and methodical.

    **Your Thought Process:**
    1.  **Analyze the User's Latest Query:** What is the user's specific intent? Is it a new search, a follow-up, a pagination request, or a general question?
    2.  **Handle Pagination:** If the user query is "show more", "next", "more options", or similar, check if `last_search_criteria` exists. If it does, this is a pagination request.
    3.  **Handle Ordinal References:** If the user says "the first one," or "the 6th," map this to the correct item in the `properties_in_context` list (0-indexed).
    4.  **Review the Context:** Look at `focused_property_id` and `focused_property_details_available`. Do I already have the info?
    5.  **Select the Correct Tool:** Based on your analysis, choose a tool.

    **TOOL DESCRIPTIONS & USAGE:**
    - `structured_property_search`: Use for NEW property searches OR for pagination requests.
    - `get_listing_details`: Use ONLY for a first-time inquiry about a specific property.
    - `respond_to_user`: Use for follow-up questions when details are ALREADY in context. `tool_input` must be null.
    - `knowledge_web_search`: Use for general real estate questions.
    - `full_text_property_search` / `semantic_property_search`: Use for broader, name-based or descriptive searches.

    **CRITICAL SCENARIOS & EXAMPLES (Follow these strictly):**

    **Scenario 1: Pagination Request**
    - **Context:** `last_search_criteria` exists, `current_session_page` is 1.
    - **User Query:** "show me more options"
    - **Your Action:** This is a pagination request. You MUST reuse the `last_search_criteria` and set the `page` parameter to `current_session_page + 1`.
    - **Your Output:** `tool_name='structured_property_search', tool_input={{...last_search_criteria, 'page': 2}}`

    **Scenario 2: Ordinal Reference Inquiry**
    - **Context:** `properties_in_context` contains 10 items.
    - **User Query:** "Tell me more about the 6th one."
    - **Your Action:** Map "6th" to index 5. Extract the ID.
    - **Your Output:** `tool_name='get_listing_details', tool_input={{'listing_id': 'id_of_the_6th_property'}}`

    **Scenario 3: Follow-up Question When Details Are Loaded**
    - **Context:** `focused_property_id` is set, `focused_property_details_available` is "Yes".
    - **User Query:** "Does it have a balcony?"
    - **Your Action:** Recognize you already have the data.
    - **Your Output:** `tool_name='respond_to_user', tool_input=null`.

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
    
    logger.info(f"Agent chose tool: {tool_choice.tool_name} with input: {tool_choice.tool_input}")

    # --- PAGINATION GUARDRAIL ---
    # This logic overrides the LLM's choice if pagination is clearly intended, ensuring reliability.
    user_query = state["messages"][-1].content.lower()
    pagination_keywords = ["more", "next", "continue", "another"]
    # Check for keywords and the existence of a previous search to continue from
    if any(keyword in user_query for keyword in pagination_keywords) and state.get("last_search_criteria"):
        logger.info("Pagination intent detected by guardrail. Overriding tool choice.")
        page_to_fetch = state.get("page", 1) + 1 # Calculate the next page number reliably
        # Manually construct the correct tool call, ignoring the LLM's output
        tool_choice = ToolChoice(
            tool_name="structured_property_search",
            tool_input={**state["last_search_criteria"], "page": page_to_fetch}
        )
    # --- END GUARDRAIL ---
    
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
    formatted_context = "No new information was gathered. Please formulate a response based on the conversation history."

    if tool_choice and tool_choice.tool_name == "respond_to_user" and state.get("focused_property_details"):
        formatted_context = f"You already have the following details for the property in focus. Use them to answer the user's latest question:\n{format_property_details(state['focused_property_details'])}"
    
    elif tool_choice and tool_output and not tool_output.startswith("Error"):
        try:
            parsed_output = json.loads(tool_output)
            is_new_search = tool_choice.tool_name in ["structured_property_search", "full_text_property_search", "semantic_property_search"]
            
            if is_new_search:
                properties_for_ui = parsed_output
                if tool_choice.tool_input and tool_choice.tool_input.get('page', 1) == 1:
                    persistent_properties = parsed_output
                else: 
                    persistent_properties.extend(parsed_output)

                formatted_context = f"Found {len(properties_for_ui)} more properties:\n{format_property_summary(properties_for_ui)}"
            
            elif tool_choice.tool_name == "get_listing_details":
                formatted_context = f"Here are the newly fetched details for the requested property:\n{format_property_details(parsed_output)}"
            
            else:
                formatted_context = tool_output
        except (json.JSONDecodeError, TypeError):
            formatted_context = tool_output

    system_template = """You are a helpful and intelligent real estate assistant. Your job is to generate a final, user-facing response based on the latest information."""
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
        messages.append(HumanMessage(content=msg.content) if msg.role == 'user' else AIMessage(content=msg.content))

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

