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
from bs4 import BeautifulSoup

# --- Environment and Global Setup ---
load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Configuration & Clients ---
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY")

if not all():
    raise ValueError("One or more required environment variables are missing.")

try:
    supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
except Exception as e:
    logger.error(f"Failed to initialize clients: {e}")
    raise

router = APIRouter()

# --- Dual-Model Architecture ---
# Use a smaller, faster model for classification and routing tasks
llm_fast = ChatGroq(temperature=0, model_name="llama-3.1-8b-instant", api_key=GROQ_API_KEY)
# Use a larger, more capable model for response synthesis
llm_smart = ChatGroq(temperature=0, model_name="llama-3.1-70b-versatile", api_key=GROQ_API_KEY)


# --- Pydantic Models for API and State ---
class Message(BaseModel):
    role: str
    content: str
    properties: Optional]] = None

class ChatRequest(BaseModel):
    messages: List[Message]
    # The following fields are included for compatibility but will be managed by the new state graph
    exclude_ids_context: Optional[List[str]] = None
    session_state: Optional] = None

# This is the new, comprehensive AgentState that will serve as the agent's memory.
class AgentState(TypedDict):
    messages: List
    user_intent: Optional]
    is_ambiguous: bool
    clarification_question: Optional[str]
    search_criteria: Dict[str, Any]
    last_successful_search: Optional]
    page: int
    properties_in_context: List]
    focused_property_id: Optional[str]
    focused_property_details: Optional]
    tool_choice: Optional]
    tool_output: Optional[str]
    # Field for returning properties to the UI
    properties_for_ui: Optional]]


# --- Tool Definitions (Phase 1 of Plan) ---

# Pydantic Schemas for Tool Inputs to ensure structured, type-safe arguments
class StructuredSearchInput(BaseModel):
    location: Optional[str] = Field(default=None, description="The city, neighborhood, or area to search for properties in. Example: 'Gurgaon'")
    property_type: Optional[str] = Field(default=None, description="The type of property, such as 'apartment', 'villa', or 'plot'.")
    min_price: Optional[float] = Field(default=None, description="The minimum budget for the property in Indian Rupees (INR).")
    max_price: Optional[float] = Field(default=None, description="The maximum budget for the property in Indian Rupees (INR).")
    bedrooms: Optional[int] = Field(default=None, description="The specific number of bedrooms required, e.g., 2 for a 2BHK.")
    page: int = Field(default=1, description="The page number of results to fetch. Use 1 for a new search.")

class ListingDetailsInput(BaseModel):
    listing_id: str = Field(description="The unique UUID of the property or project to get details for. This ID must be retrieved from a previous search.")

# Tool Implementations with detailed docstrings for the orchestrator LLM
@tool(args_schema=StructuredSearchInput)
async def structured_property_search(location: Optional[str] = None, property_type: Optional[str] = None, min_price: Optional[float] = None, max_price: Optional[float] = None, bedrooms: Optional[int] = None, page: int = 1) -> str:
    """
    Use this tool for specific, filtered searches for properties when the user provides concrete criteria.
    This is the primary tool for new searches and for refining existing searches.
    For example, use this for queries like: 'find 2 bedroom apartments in Gurgaon under 50 lakhs'.
    To show more results for a previous search (pagination), use this tool and increment the 'page' number.
    Do NOT use this for vague or conceptual searches like 'something modern' or for finding a property by its name.
    """
    logger.info(f"TOOL CALL: structured_property_search with page: {page} and criteria: {{'location': '{location}', 'bedrooms': {bedrooms},...}}")
    params = {
        "p_location": location, "p_property_type": property_type, "p_min_price": min_price,
        "p_max_price": max_price, "p_bedrooms": bedrooms, "p_page": page, "p_limit": 5
    }
    response = await asyncio.to_thread(supabase_client.rpc("search_all_properties", params).execute)
    return json.dumps(response.data, indent=2) if response.data else "No properties found matching your criteria."

@tool
async def text_search_properties(query: str) -> str:
    """
    Use this tool ONLY when the user is searching for a property or project by its specific name.
    For example, use this for queries like: 'tell me about Azure Heights' or 'do you have anything in DLF Crest?'.
    Do NOT use this for general filtered searches.
    """
    logger.info(f"TOOL CALL: text_search_properties for query: '{query}'")
    params = {"p_query": query}
    response = await asyncio.to_thread(supabase_client.rpc("text_search_properties", params).execute)
    return json.dumps(response.data, indent=2) if response.data else f"No properties found for '{query}'."

@tool
async def semantic_property_search(query: str) -> str:
    """
    Use this tool for vague, conceptual, or descriptive searches when the user asks for something qualitative.
    For example, use this for queries like: 'find a quiet family home' or 'show me properties with a modern design'.
    Do NOT use this for specific, filtered searches (e.g., '3bhk in gurgaon').
    """
    logger.info(f"TOOL CALL: semantic_property_search for query: '{query}'")
    query_embedding = embedding_engine.embed_query(query)
    params = {"query_embedding": query_embedding, "match_threshold": 0.75, "match_count": 5}
    response = await asyncio.to_thread(supabase_client.rpc("match_property_chunks", params).execute)
    return json.dumps(response.data, indent=2) if response.data else "No properties found for that description."

@tool(args_schema=ListingDetailsInput)
async def get_listing_details(listing_id: str) -> str:
    """
    Use this tool to get all detailed information about a single, specific property or project.
    You MUST have the 'listing_id' from a previous search result to use this tool.
    Use this when the user asks for more details about a property you have already shown them (e.g., 'tell me more about the second one').
    """
    logger.info(f"TOOL CALL: get_listing_details for ID: '{listing_id}'")
    params = {"p_listing_id": listing_id}
    response = await asyncio.to_thread(supabase_client.rpc("get_listing_details", params).single().execute)
    return json.dumps(response.data, indent=2) if response.data else f"Could not find details for listing ID {listing_id}."

knowledge_web_search = TavilySearchResults(max_results=3, api_key=TAVILY_API_KEY)
knowledge_web_search.name = "knowledge_web_search"
knowledge_web_search.description = "Use this tool for general real estate questions, like 'what is stamp duty?' or 'how do home loans work in India?'."

tools = {
    "structured_property_search": structured_property_search,
    "text_search_properties": text_search_properties,
    "semantic_property_search": semantic_property_search,
    "get_listing_details": get_listing_details,
    "knowledge_web_search": knowledge_web_search,
}

# --- Graph Nodes (Phase 2 & 3 of Plan) ---

async def classify_intent_node(state: AgentState) -> Dict[str, Any]:
    """Node 1: Classifies the user's intent based on the conversation history."""
    logger.info("--- NODE: Classify Intent ---")
    system_prompt = """You are an expert at classifying user intent within a real estate conversation.
Analyze the final user message in the context of the conversation history.
Classify the user's intent into ONE of the following categories:

- NEW_SEARCH: The user is starting a new search for properties. (e.g., "find 3 bhk in gurgaon", "show me plots for sale")
- REFINE_SEARCH: The user is adding, removing, or changing criteria for an existing search. (e.g., "only show me ones with a pool", "what about in a lower price range?")
- REQUEST_DETAILS: The user is asking for more information about a specific property already mentioned. (e.g., "tell me more about the second one", "what is the exact price of Azure Heights?")
- PAGINATION: The user wants to see more results from the previous search. (e.g., "show me more", "next page", "what else do you have?")
- CLARIFICATION_RESPONSE: The user is answering a direct question you previously asked. (e.g., Your last message: "Which city?", User's message: "New Delhi")
- META_COMMAND: The user is giving a command about the conversation itself. (e.g., "start over", "forget that", "reset")
- GENERAL_QUERY: The user is asking a general real estate question not related to a specific listing search. (e.g., "what is stamp duty?", "how do I get a home loan?")
"""
    class Intent(BaseModel):
        intent: Literal = Field(description="The user's classified intent.")
        extracted_criteria: Optional] = Field(default_factory=dict, description="Any newly mentioned search criteria like location, price, or bedrooms.")

    parser = llm_fast.with_structured_output(Intent)
    prompt = ChatPromptTemplate.from_messages([("system", system_prompt), ("user", "{history}")])
    chain = prompt | parser
    history_str = "\n".join([f"{m.type}: {m.content}" for m in state["messages"]])
    
    response = await chain.ainvoke({"history": history_str})
    
    logger.info(f"Intent classified as: {response.intent} with criteria: {response.extracted_criteria}")

    # Update search criteria, merging new with old
    updated_criteria = state.get('search_criteria', {}).copy()
    if response.extracted_criteria:
        updated_criteria.update(response.extracted_criteria)

    return {"user_intent": response.intent, "search_criteria": updated_criteria}


async def validate_and_clarify_node(state: AgentState) -> Dict[str, Any]:
    """Node 2: Validates if enough information exists to proceed. If not, asks a clarifying question."""
    logger.info("--- NODE: Validate and Clarify ---")
    intent = state.get('user_intent')
    criteria = state.get('search_criteria', {})

    if intent in:
        if not criteria.get('location'):
            logger.info("Ambiguity detected: Location is missing for search.")
            return {
                "is_ambiguous": True,
                "clarification_question": "Of course! To find the best properties for you, could you please tell me which city or area you're interested in?"
            }
    
    logger.info("Validation passed. No ambiguity detected.")
    return {"is_ambiguous": False}


async def tool_orchestrator_node(state: AgentState) -> Dict[str, Any]:
    """Node 3: Selects the correct tool and parameters based on the unambiguous intent."""
    logger.info("--- NODE: Tool Orchestrator ---")
    intent = state.get('user_intent')
    criteria = state.get('search_criteria', {})
    last_search = state.get('last_successful_search', {})
    page = state.get('page', 1)

    tool_choice = None

    if intent == "META_COMMAND":
        logger.info("Handling META_COMMAND: Resetting state.")
        # This is a state manipulation, not a tool call. We will clear state and route to response synthesizer.
        return {
            "messages": [state['messages']], # Keep system message
            "search_criteria": {},
            "last_successful_search": None,
            "properties_in_context":,
            "focused_property_id": None,
            "focused_property_details": None,
            "page": 1,
            "tool_choice": {"tool_name": "meta_reset", "tool_input": {}}
        }

    if intent in:
        tool_choice = {"tool_name": "structured_property_search", "tool_input": {**criteria, "page": 1}}
    
    elif intent == "PAGINATION" and last_search:
        tool_choice = {"tool_name": "structured_property_search", "tool_input": {**last_search, "page": page + 1}}

    elif intent == "REQUEST_DETAILS":
        # Simple logic to find the requested property in context
        # A more robust implementation would use an LLM to parse "the second one", etc.
        if criteria.get('listing_id'):
             tool_choice = {"tool_name": "get_listing_details", "tool_input": {"listing_id": criteria['listing_id']}}
        else: # Fallback if ID not directly extracted
            # For now, we assume the user is asking about the first property if not specified
            if state.get('properties_in_context'):
                first_prop_id = state['properties_in_context'].get('id')
                if first_prop_id:
                    tool_choice = {"tool_name": "get_listing_details", "tool_input": {"listing_id": first_prop_id}}

    elif intent == "GENERAL_QUERY":
        last_message = state['messages'][-1].content
        tool_choice = {"tool_name": "knowledge_web_search", "tool_input": {"query": last_message}}

    if not tool_choice:
        logger.warning("No tool could be chosen for the intent. Defaulting to general response.")
        tool_choice = {"tool_name": "respond_to_user", "tool_input": {}}

    logger.info(f"Orchestrator chose tool: {tool_choice['tool_name']} with input: {tool_choice['tool_input']}")
    return {"tool_choice": tool_choice}


async def tool_executor_node(state: AgentState) -> Dict[str, Any]:
    """Node 4: Executes the chosen tool."""
    logger.info("--- NODE: Tool Executor ---")
    tool_choice = state.get("tool_choice")
    if not tool_choice or tool_choice.get("tool_name") == "meta_reset":
        return {"tool_output": "State was reset."}

    tool_to_call = tools.get(tool_choice['tool_name'])
    if not tool_to_call:
        return {"tool_output": f"Error: Tool '{tool_choice['tool_name']}' not found."}

    try:
        output = await tool_to_call.ainvoke(tool_choice['tool_input'])
        
        # Update state based on tool call
        next_state = {"tool_output": output}
        if tool_choice['tool_name'] == 'structured_property_search':
            next_state['last_successful_search'] = tool_choice['tool_input']
            next_state['page'] = tool_choice['tool_input'].get('page', 1)
        
        return next_state
    except Exception as e:
        logger.error(f"Error executing tool {tool_choice['tool_name']}: {e}")
        return {"tool_output": f"An error occurred: {e}"}


async def response_synthesizer_node(state: AgentState) -> Dict[str, Any]:
    """Node 5: Crafts the final user-facing response based on all context."""
    logger.info("--- NODE: Response Synthesizer ---")
    
    system_prompt = """You are a helpful and friendly real estate assistant.
Your goal is to synthesize the provided information into a concise, natural, and helpful response.
Always follow these rules:
1.  Provide a brief, natural-language summary of the new information found. Do NOT just repeat the raw data.
2.  If new properties were found, mention the number and show a brief summary.
3.  If details for a property were found, summarize the key highlights.
4.  If the state was reset, confirm it and ask the user what they're looking for.
5.  Always end your response by proposing clear and helpful next steps for the user (e.g., "Would you like more details on one of these, or should I refine the search?").
"""
    prompt = ChatPromptTemplate.from_messages()
    chain = prompt | llm_smart

    history_str = "\n".join([f"{m.type}: {m.content}" for m in state["messages"]])
    context = state.get('tool_output', "No new information.")
    properties_for_ui = None

    # Process tool output for context and UI
    if state.get('tool_choice', {}).get('tool_name') == 'meta_reset':
        context = "The conversation has been reset."
    elif state.get('tool_output'):
        try:
            data = json.loads(state['tool_output'])
            if isinstance(data, list) and data: # It's a list of properties
                properties_for_ui = data
                context = f"Found {len(data)} properties. Here are their summaries:\n"
                context += "\n".join([f"- {p.get('title')} in {p.get('location')}" for p in data])
                # Update properties in context for future reference
                state['properties_in_context'] = data
            elif isinstance(data, dict) and 'title' in data: # It's property details
                state['focused_property_details'] = data
                context = f"Details for {data.get('title')}:\n"
                context += f"Description: {BeautifulSoup(data.get('description', ''), 'html.parser').get_text(separator=' ', strip=True)[:200]}...\n"
                context += f"Price: {data.get('price')}\n"
                context += f"Location: {data.get('location_text')}"
        except (json.JSONDecodeError, TypeError):
            # Output is likely just text (from web search or an error)
            context = state['tool_output']

    response = await chain.ainvoke({"history": history_str, "context": context})
    
    ai_message = AIMessage(content=response.content)
    
    return {
        "messages": state["messages"] + [ai_message],
        "properties_for_ui": properties_for_ui
    }

# --- Conditional Edges for Routing ---

def should_clarify(state: AgentState) -> Literal["clarify_user", "tool_orchestrator"]:
    """Edge 1: Routes to clarification if the request is ambiguous."""
    if state.get("is_ambiguous"):
        return "clarify_user"
    return "tool_orchestrator"

def should_execute_tool(state: AgentState) -> Literal["tool_executor", "response_synthesizer"]:
    """Edge 2: Skips tool execution for meta-commands or if no tool is needed."""
    tool_name = state.get("tool_choice", {}).get("tool_name")
    if tool_name in ["meta_reset", "respond_to_user"]:
        return "response_synthesizer"
    return "tool_executor"

# --- Graph Assembly ---

def build_graph():
    workflow = StateGraph(AgentState)

    # Add nodes
    workflow.add_node("classify_intent", classify_intent_node)
    workflow.add_node("validate_and_clarify", validate_and_clarify_node)
    workflow.add_node("tool_orchestrator", tool_orchestrator_node)
    workflow.add_node("tool_executor", tool_executor_node)
    workflow.add_node("response_synthesizer", response_synthesizer_node)
    
    # A simple node to send back the clarification question
    def clarify_user_node(state: AgentState):
        logger.info("--- NODE: Clarify User ---")
        ai_message = AIMessage(content=state['clarification_question'])
        return {"messages": state['messages'] + [ai_message]}

    workflow.add_node("clarify_user", clarify_user_node)

    # Define edges
    workflow.set_entry_point("classify_intent")
    workflow.add_edge("classify_intent", "validate_and_clarify")
    
    workflow.add_conditional_edges(
        "validate_and_clarify",
        should_clarify,
        {
            "clarify_user": "clarify_user",
            "tool_orchestrator": "tool_orchestrator"
        }
    )
    
    workflow.add_conditional_edges(
        "tool_orchestrator",
        should_execute_tool,
        {
            "tool_executor": "tool_executor",
            "response_synthesizer": "response_synthesizer"
        }
    )
    
    workflow.add_edge("tool_executor", "response_synthesizer")
    workflow.add_edge("response_synthesizer", END)
    workflow.add_edge("clarify_user", END)

    return workflow.compile()

app = build_graph()

# --- FastAPI Endpoint ---

@router.post("/api/chat_langchain")
async def chat_langchain_endpoint(request: ChatRequest):
    """Main endpoint to interact with the refactored LangGraph agent."""
    try:
        # Convert incoming messages to LangChain format
        messages = [HumanMessage(content=msg.content) if msg.role == 'user' else AIMessage(content=msg.content) for msg in request.messages]
        
        # Initialize state for the graph
        initial_state: AgentState = {
            "messages": messages,
            "user_intent": None,
            "is_ambiguous": False,
            "clarification_question": None,
            "search_criteria": request.session_state.get("search_criteria", {}) if request.session_state else {},
            "last_successful_search": request.session_state.get("last_successful_search") if request.session_state else None,
            "page": request.session_state.get("page", 1) if request.session_state else 1,
            "properties_in_context": request.session_state.get("properties_in_context",) if request.session_state else,
            "focused_property_id": None,
            "focused_property_details": None,
            "tool_choice": None,
            "tool_output": None,
            "properties_for_ui": None,
        }

        # Invoke the graph
        final_state = await app.ainvoke(initial_state)

        # Format the response for the frontend
        last_message = final_state["messages"][-1]
        response_text = last_message.content if isinstance(last_message, AIMessage) else "An error occurred."
        
        # Prepare session state to send back to client
        session_state_to_return = {
            "search_criteria": final_state.get("search_criteria"),
            "last_successful_search": final_state.get("last_successful_search"),
            "page": final_state.get("page"),
            "properties_in_context": final_state.get("properties_in_context"),
        }

        return {
            "text_response": response_text,
            "properties": final_state.get("properties_for_ui"),
            "session_state": session_state_to_return,
        }

    except Exception as e:
        logger.error(f"Error in chat endpoint: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
