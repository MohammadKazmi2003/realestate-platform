"""
This file implements the refactored, context-first conversational agent.
(Version 10 - Optimized for Speed & Accuracy)

This version fixes the performance bottlenecks and accuracy issues from V9.
It removes the serial `build_context_node` and returns to a "context-on-demand"
model with a lean, parallelized entry point.

Key Fixes:
1.  `classify_intent` is the entry point again.
2.  `classify_intent` now runs 3 tasks in parallel (Intent LLM, RAG, Summarization)
    to eliminate serial bottlenecks.
3.  **ACCURACY FIX:** `classify_intent` now receives `properties_in_context`
    so it can correctly distinguish `REQUEST_DETAILS`.
4.  Helper nodes (`_extract_...`) are slimmed down and only receive the
    *recent* history, making them fast and accurate again.
5.  Only the final `response_synthesizer_node` receives the full 4-part context.
"""

import os
import json
import logging
import asyncio  # For parallel execution
from typing import List, Dict, Any, Optional, TypedDict, Literal
from uuid import UUID
import re
from bs4 import BeautifulSoup

from dotenv import load_dotenv
from pydantic import BaseModel, Field, field_validator
from langchain_core.messages import HumanMessage, AIMessage, BaseMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_groq import ChatGroq
from langchain_core.output_parsers import StrOutputParser, PydanticOutputParser
from supabase import create_client, Client
from langgraph.graph import StateGraph, END

# Import the newly created tool definitions
from api_py.tools import (
    tools,
    StructuredSearchInput, ListingDetailsInput,
    TextSearchInput, SemanticSearchInput, KnowledgeSearchInput
)
from api_py.vector_store import ChatVectorStore
from api_py.shared_embedding import embedding_engine as get_embedding_model

# --- Environment and Global Setup ---
load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Configuration & Clients ---
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

if not all([GROQ_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY]):
    raise ValueError("GROQ_API_KEY, SUPABASE_URL, and SUPABASE_SERVICE_KEY environment variables are missing.")

llm_router = ChatGroq(temperature=0, model_name="llama-3.1-8b-instant", api_key=GROQ_API_KEY)
llm_generator = ChatGroq(temperature=0, model_name="llama-3.1-8b-instant", api_key=GROQ_API_KEY)
llm_summarizer = ChatGroq(temperature=0, model_name="llama-3.1-8b-instant", api_key=GROQ_API_KEY)

# --- Global Instantiation for Vector Store ---
try:
    supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    embedding_model = get_embedding_model
    global_vector_store = ChatVectorStore(supabase_client, embedding_model)
except Exception as e:
    logger.error(f"Failed to initialize global clients: {e}", exc_info=True)
    raise

# --- Constants for Dynamic Context ---
RECENT_MESSAGE_COUNT = 10  # Keep the last 5 user/bot exchanges
HISTORY_THRESHOLD = 12     # Start summarizing when total messages > 12
MEANINGFUL_QUERY_WORDS = 2
MEANINGFUL_ANSWER_WORDS = 5

# --- Pydantic Models (Unchanged) ---

class Message(BaseModel):
    role: str
    content: str
    properties: Optional[List[Dict[str, Any]]] = None

class ChatRequest(BaseModel):
    messages: List[Message]
    session_state: Dict[str, Any] = {}
    session_id: str

class ToolChoice(BaseModel):
    tool_name: Literal[
        "structured_property_search",
        "full_text_property_search",
        "semantic_property_search",
        "get_listing_details",
        "knowledge_web_search",
        "respond_to_user"
    ] = Field(description="The name of the tool to execute.")
    tool_input: Optional[Dict[str, Any]] = Field(
        default=None,
        description="The input parameters for the chosen tool, as a dictionary."
    )

class ExtractedSearchCriteria(BaseModel):
    location: Optional[str] = Field(default=None, description="The city, neighborhood, or area.")
    property_type: Optional[str] = Field(default=None, description="e.g., 'apartment', 'villa', 'plot'")
    min_price: Optional[float] = Field(default=None, description="The minimum numerical price. e.g., 5000000")
    max_price: Optional[float] = Field(default=None, description="The maximum numerical price. e.g., 10000000")
    bedrooms: Optional[int] = Field(default=None, description="The number of bedrooms. e.g., 2")

    @field_validator('property_type')
    @classmethod
    def validate_property_type(cls, v: Optional[str]) -> Optional[str]:
        if v is None: return None
        v_lower = v.lower()
        if 'apartment' in v_lower: return 'apartment'
        if 'villa' in v_lower: return 'villa'
        if 'plot' in v_lower: return 'plot'
        if 'commercial' in v_lower: return 'commercial'
        if 'land' in v_lower: return 'land'
        return v

    @field_validator('bedrooms')
    @classmethod
    def validate_bedrooms(cls, v: Optional[int]) -> Optional[int]:
        if isinstance(v, str):
            match = re.search(r'\d+', v)
            if match:
                return int(match.group(0))
        return v

def _parse_price(text: str) -> Optional[float]:
    text = text.lower().strip()
    match = re.search(r'([\d\.]+)', text)
    if not match: return None
    num = float(match.group(1))
    if 'crore' in text or 'cr' in text: return num * 10000000
    if 'lakh' in text or 'lac' in text: return num * 100000
    if 'million' in text: return num * 1000000
    if 'thousand' in text or 'k' in text: return num * 1000
    return num

# --- Helper Functions (Unchanged & NEW) ---

def strip_html(text: Optional[str]) -> str:
    if not text: return ""
    try: return BeautifulSoup(text, "lxml").get_text(" ", strip=True)
    except:
        try: return BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
        except Exception: return str(text)

def format_property_summary(properties: List[Dict[str, Any]]) -> str:
    if not properties: return "No properties found."
    summary_lines = []
    for i, prop in enumerate(properties, 1):
        price_num = prop.get('price')
        price = f"AED{price_num:,.0f}" if isinstance(price_num, (int, float)) else "Price on request"
        summary_lines.append(
            f"Index: {i}, ID: {prop.get('id')}, Title: {prop.get('title')}, Price: {price}, Location: {prop.get('location')}"
        )
    return "\n".join(summary_lines)

def format_property_details(details: Dict[str, Any]) -> str:
    # (This function is unchanged from V9, omitted for brevity)
    # ... (Keep the full function from V9) ...
    if not details: return "No details available for this property."
    output_lines = []
    def format_value(val):
        if val is None or val == '': return None
        if isinstance(val, bool): return "Yes" if val else "No"
        if isinstance(val, (int, float)):
            if val > 100000: return f"₹{val:,.0f}"
            return str(val)
        return str(val)
    key_fields = ['title', 'description', 'description_html', 'price']
    for key in key_fields:
        if key in details:
            val = format_value(details[key])
            if val:
                key_title = key.replace('_', ' ').title()
                if 'description' in key: output_lines.append(f"\n{key_title}:\n{strip_html(val)}")
                else: output_lines.append(f"{key_title}: {val}")
    for key, value in details.items():
        if key in key_fields or value is None or value == '' or key.startswith('lookup_') or 'media' in key:
            continue
        formatted_key = key.replace('_', ' ').title()
        if isinstance(value, list) and value:
            if all(isinstance(item, dict) for item in value):
                if key.startswith('details_') and value[0]:
                    output_lines.append(f"\n{formatted_key}:")
                    for sub_key, sub_val in value[0].items():
                        if 'id' not in sub_key and not isinstance(sub_val, (dict, list)):
                            formatted_sub_val = format_value(sub_val)
                            if formatted_sub_val: output_lines.append(f"  {sub_key.replace('_', ' ').title()}: {formatted_sub_val}")
                elif key == 'faqs' and all('question' in item and 'answer' in item for item in value):
                    output_lines.append("\nFAQs:")
                    for item in value: output_lines.append(f"  Q: {item.get('question')}\n  A: {item.get('answer')}")
                else:
                    items = [item.get('name') for item in value if item.get('name')]
                    if items: output_lines.append(f"{formatted_key}: {', '.join(items)}")
            elif all(isinstance(item, (str, int, float)) for item in value):
                items = [format_value(item) for item in value if item]
                if items: output_lines.append(f"{formatted_key}: {', '.join(items)}")
        elif isinstance(value, dict) and value:
            output_lines.append(f"\n{formatted_key}:")
            for sub_key, sub_val in value.items():
                formatted_sub_val = format_value(sub_val)
                if formatted_sub_val: output_lines.append(f"  {sub_key.replace('_', ' ').title()}: {formatted_sub_val}")
    return "\n".join(output_lines)


def _clean_query_for_text_search(query: str) -> str:
    import re
    cleaned = re.sub(
        r"^(show me|find|search for|look up|give me|i want|tell me about)\s+", "", 
        query, 
        flags=re.IGNORECASE
    )
    cleaned = cleaned.strip(" .,:;!?\"'")
    return cleaned

def _format_messages_for_prompt(messages: List[BaseMessage]) -> str:
    """Converts a list of BaseMessages into a simple string."""
    return "\n".join([f"{m.type}: {m.content}" for m in messages])

async def _summarize_history_chain(messages_to_summarize: List[BaseMessage]) -> str:
    """
    A dedicated chain to summarize old messages.
    """
    if not messages_to_summarize:
        return ""
        
    logger.info(f"Invoking summarizer for {len(messages_to_summarize)} messages.")
    
    summarizer_prompt = ChatPromptTemplate.from_messages([
        ("system", "You are an expert at summarizing conversations. Create a concise, third-person summary of the following history. Focus on key decisions, search parameters, and properties discussed. Do not add any preamble."),
        ("user", "Conversation History:\n{history}\n\nSummary:")
    ])
    
    summarizer_chain = summarizer_prompt | llm_summarizer | StrOutputParser()
    
    history_str = _format_messages_for_prompt(messages_to_summarize)
    
    try:
        summary = await summarizer_chain.ainvoke({"history": history_str})
        return summary
    except Exception as e:
        logger.error(f"Error during summarization: {e}")
        return "" # Return empty string on failure

# --- NEWLY RESTORED HELPER FUNCTION ---

class PropertyIDMatcher(BaseModel):
    property_id: Optional[str] = Field(
        default=None,
        description="The single property ID (e.g., 'p-1a2b3c') the user is referring to."
    )

async def _find_property_id_from_context(
    user_message: str,
    properties_in_context: List[Dict[str, Any]]
) -> Optional[str]:
    """
    Uses an LLM to find the specific property ID the user is referring to.
    (Restored in V10.1 to fix NameError)
    """
    logger.info("--- Helper: _find_property_id_from_context ---")
    if not properties_in_context:
        logger.warning("No properties in context to search for details.")
        return None
        
    property_summary = format_property_summary(properties_in_context)
    
    parser = PydanticOutputParser(pydantic_object=PropertyIDMatcher)
    
    system_template = """You are an expert at matching a user's request to a list of properties.
    Analyze the "User's Request" and find the matching property ID from the "Property List".

    **CRITICAL RULES:**
    1.  "first one", "the first property" -> Corresponds to `Index: 1`
    2.  "second one", "number 2" -> Corresponds to `Index: 2`
    3.  If the user mentions a name (e.g., "Azure Heights"), find the property with that title.
    4.  You MUST respond with the `ID` (e.g., 'p-1a2b3c'), NOT the `Index` (e.g., 1).
    5.  If no match is found, respond with `null`.

    {format_instructions}
    """
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("human", "Property List:\n{property_list}\n\nUser's Request: '{user_message}'\n\nMatched ID:")
    ])
    
    chain = prompt | llm_router | parser
    
    try:
        result = await chain.ainvoke({
            "property_list": property_summary,
            "user_message": user_message,
            "format_instructions": parser.get_format_instructions()
        })
        if result.property_id:
            logger.info(f"LLM matched user request to property ID: {result.property_id}")
            return result.property_id
        else:
            logger.warning("LLM could not match user request to any property in context.")
            return None
    except Exception as e:
        logger.error(f"Error during property ID matching: {e}")
        return None

# --- LangGraph State Definition (UPDATED) ---

UserIntent = Literal[
    "NEW_SEARCH", "REFINE_SEARCH", "REQUEST_DETAILS",
    "FOLLOW_UP_QUESTION",
    "PAGINATION", "CLARIFICATION_RESPONSE", "META_COMMAND_RESET", "GENERAL_QUERY",
    "PROJECT_NAME_SEARCH","SEMANTIC_SEARCH"
]

class AgentState(TypedDict):
    """The full state object for the conversational agent."""
    # --- Context Components ---
    messages: List[BaseMessage]             # Full, persistent history
    summary: str                          # Summary of old messages (from *start* of turn)
    recent_messages: List[BaseMessage]      # Last N messages (computed in entry node)
    session_memory: List[str]               # RAG vector results (computed in entry node)
    tool_output: Optional[str]              # Output of the last tool run
    
    # --- Session/Lifecycle Management ---
    session_id: str
    user_intent: Optional[UserIntent]
    search_criteria: Dict[str, Any]
    last_successful_search: Optional[Dict[str, Any]]
    page: int
    
    # --- Property/Tool State ---
    properties_in_context: List[Dict[str, Any]] # CRITICAL: For intent accuracy
    focused_property_id: Optional[str]
    focused_property_details: Optional[Dict[str, Any]]
    tool_choice: Optional[ToolChoice]
    properties_for_ui: Optional[List[Dict[str, Any]]]


# --- Agent Nodes (REFACTORED) ---

class IntentParser(BaseModel):
    intent: UserIntent = Field(
        description="The single, most likely intent of the user's *last* message."
    )

async def classify_intent_node(state: AgentState) -> Dict[str, Any]:
    """
    Node 1 (NEW Entry Point): Lean, fast, and parallelized.
    1.  Runs a *lean* Intent LLM call (await).
    2.  Runs RAG search (await).
    3.  Runs Summarization (no await, background task) for the *next* turn.
    """
    logger.info("--- NODE: 1. Classify Intent & Gather Context (Parallel) ---")
    
    # --- Clear stale data from previous turn ---
    state["tool_output"] = None
    state["properties_for_ui"] = None
    
    messages = state["messages"]
    last_query = messages[-1].content
    session_id = state["session_id"]
    
    # --- 1. Prepare lean context for the Intent LLM ---
    recent_messages = messages[-RECENT_MESSAGE_COUNT:]
    properties_on_screen_str = format_property_summary(state.get("properties_in_context", []))
    recent_messages_str = _format_messages_for_prompt(recent_messages)

    intent_prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert at classifying user intent.
        
        **CRITICAL CONTEXT:**
        - "Properties on Screen" lists items the user is *currently looking at*.
        - "Recent History" shows the immediate conversation.

        **Classify the 'User's final message' into ONE intent:**
        - NEW_SEARCH: Starting a new search. (e.g., "find 3 bhk in gurgaon")
        - REFINE_SEARCH: Changing criteria for an *existing search*. (e.g., "only show me ones with a pool")
        - **REQUEST_DETAILS:** Asking for info on a *specific property* from the "Properties on Screen". (e.g., "tell me more about the second one", "what is the price of Azure Heights?")
        - FOLLOW_UP_QUESTION: Asking a question when *details are already being discussed*. (e.g., "does it have parking?")
        - PAGINATION: Asking for more results. (e.g., "show me more")
        - CLARIFICATION_RESPONSE: Answering a direct question from the bot.
        - META_COMMAND_RESET: "start over", "reset"
        - GENERAL_QUERY: General real estate question.
        - PROJECT_NAME_SEARCH: User mentions a specific project name. (e.g., "find Sobha Hartland")
        - SEMANTIC_SEARCH: A descriptive, lifestyle-based query. (e.g., "apartments with sea views")

        **RULES:**
        - If "Properties on Screen" is NOT empty and the user asks about "the first one" or a name from that list, it is **REQUEST_DETAILS**.
        - If "Properties on Screen" IS empty and the user asks "show me places with a pool", it is **NEW_SEARCH** or **REFINE_SEARCH**.
        
        {format_instructions}
        """),
        ("human", """[Properties on Screen]:
{properties_on_screen}

[Recent History]:
{recent_messages}

User's final message: '{last_message}'

Classification:""")
    ])
    
    parser = PydanticOutputParser(pydantic_object=IntentParser)
    intent_chain = intent_prompt | llm_router | parser

    # --- 2. Define the parallel tasks ---
    
    async def task_1_run_intent_llm():
        """
        Runs the lean, fast intent classification.
        **This is the accuracy fix.**
        """
        try:
            result = await intent_chain.ainvoke({
                "properties_on_screen": properties_on_screen_str or "None",
                "recent_messages": recent_messages_str,
                "last_message": last_query,
                "format_instructions": parser.get_format_instructions()
            })
            logger.info(f"Intent classified as: {result.intent}")
            return result.intent
        except Exception as e:
            logger.error(f"Error during intent classification: {e}")
            return "GENERAL_QUERY" # Failsafe

    async def task_2_run_rag_search():
        """
        Fetches relevant past exchanges for the *final synthesizer*.
        """
        if session_id:
            logger.info("RAG task: Searching memory...")
            return await global_vector_store.search_memory(session_id, last_query, k=3)
        else:
            logger.warning("RAG task: No Session ID. Skipping memory search.")
            return []

    async def task_3_run_summarization():
        """
        Summarizes old history *for the next turn*.
        Returns the summary from the *start* of this turn,
        and kicks off a new summary in the background if needed.
        """
        summary_from_start_of_turn = state.get("summary", "")
        
        old_messages = messages[:-RECENT_MESSAGE_COUNT]
        if len(messages) > HISTORY_THRESHOLD and old_messages:
            logger.info(f"Summarization task: Kicking off background summary for {len(old_messages)} messages.")
            # We create the task but don't await it.
            # Its result will be saved to session state by the *next* turn's invocation.
            # For this turn, we just return the summary we came in with.
            #
            # A more complex (but correct) way is to `await` this and pass the
            # *new* summary to the state. Let's do that to keep state consistent.
            # This task will run in parallel with the others.
            new_summary = await _summarize_history_chain(old_messages)
            return new_summary
        
        # If no summary needed, just return the one we started with.
        return summary_from_start_of_turn

    # --- 3. Run tasks in parallel ---
    try:
        # We await all three tasks. This is still much faster than V9,
        # as they all start at the same time. The node's total time
        # is max(intent_llm, rag, summary_llm), not a sum.
        intent_result, rag_results, summary_result = await asyncio.gather(
            task_1_run_intent_llm(),
            task_2_run_rag_search(),
            task_3_run_summarization()
        )
        
        return {
            "user_intent": intent_result,
            "session_memory": rag_results,
            "summary": summary_result,
            "recent_messages": recent_messages, # Pass this along
            "tool_output": None,
            "properties_for_ui": None,
        }
    except Exception as e:
        logger.error(f"Error during parallel context building: {e}", exc_info=True)
        # Failsafe
        return {
            "user_intent": "GENERAL_QUERY",
            "session_memory": [],
            "summary": state.get("summary", ""),
            "recent_messages": recent_messages,
            "tool_output": None,
            "properties_for_ui": None,
        }


async def _extract_and_merge_criteria(state: AgentState) -> Dict[str, Any]:
    """
    (Refactored Helper - LEAN)
    Only uses RECENT messages for context.
    """
    logger.info("--- Helper: _extract_and_merge_criteria (Lean) ---")
    
    current_criteria = state.get("search_criteria", {})
    # Use the 'recent_messages' computed by the entry node
    recent_messages_str = _format_messages_for_prompt(state["recent_messages"])
    last_message = state["recent_messages"][-1].content
    
    parser = PydanticOutputParser(pydantic_object=ExtractedSearchCriteria)

    system_template = """You are an expert at extracting structured real estate data.
    Your goal is to update search parameters based on the *User's final message*,
    using the "Recent Conversation" for context.

    **CRITICAL RULES:**
    1.  If the bot asked a question (e.g., "Which location?") and the user answers ("Dubai Marina"), extract that.
    2.  If the bot *suggested* a parameter (e.g., "Did you mean 2 bedrooms?") and the user confirms ("yes"), extract that.
    3.  `bedrooms`: '2bhk', '2 bedroom' -> `bedrooms: 2`
    4.  `price`: 'under 1 million' -> `max_price: 1000000`
    5.  If a value is not mentioned, omit the key.

    {format_instructions}
    """

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("human", """[Recent Conversation (Bot's last message is most important)]:
{recent_messages}

User's final message: '{last_message}'

Extracted Parameters:""")
    ])

    chain = prompt | llm_router | parser

    try:
        extracted_data = await chain.ainvoke({
            "recent_messages": recent_messages_str,
            "last_message": last_message,
            "format_instructions": parser.get_format_instructions()
        })
        new_criteria = extracted_data.model_dump()
        merged_criteria = current_criteria.copy()
        update_count = 0
        for key, value in new_criteria.items():
            if value is not None:
                merged_criteria[key] = value
                update_count += 1
        logger.info(f"Extracted criteria: {new_criteria}")
        logger.info(f"Merged {update_count} new values. Final criteria: {merged_criteria}")
        return merged_criteria
    except Exception as e:
        logger.error(f"Error during parameter extraction: {e}")
        return current_criteria

async def _llm_extract_project_name_query(state: AgentState) -> str:
    """
    (Refactored Helper - LEAN)
    Only uses RECENT messages for context.
    """
    logger.info("--- Helper: _llm_extract_project_name_query (Lean) ---")
    
    recent_messages_str = _format_messages_for_prompt(state["recent_messages"])
    user_query = state["recent_messages"][-1].content
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are an expert assistant that extracts only the property or project name from a user query. Use the 'Recent Conversation' for context. Remove all polite phrases and commands. Examples:\n- Input: 'Show me Riverside Views - Royal 1' => Output: 'Riverside Views - Royal 1'\n- Input: 'Find Azizi Venice 13' => Output: 'Azizi Venice 13'"),
        ("human", """[Recent Conversation]:
{recent_messages}

User's final message: '{user_query}'

Extracted Search Phrase:""")
    ])
    chain = prompt | llm_router | StrOutputParser()
    
    response = await chain.ainvoke({
        "recent_messages": recent_messages_str,
        "user_query": user_query
    })
    return response.strip(" \n.:;!?\"'")


async def tool_orchestrator(state: AgentState) -> Dict[str, Any]:
    """
    Node 2 (Refactored): Selects the correct tool AND parameters.
    Uses new LEAN, context-aware helpers.
    """
    logger.info(f"--- NODE: 2. Tool Orchestrator (Intent: {state.get('user_intent')}) ---")
    user_intent = state.get("user_intent")
    current_criteria = state.get("search_criteria", {})
    last_search = state.get("last_successful_search", {})
    current_page = state.get("page", 1)

    if user_intent == "META_COMMAND_RESET":
        logger.info("Handling META_COMMAND_RESET: Clearing state.")
        return {
            "summary": "", # Clear summary
            "recent_messages": [state["messages"][-1]], # Keep only last user message
            "search_criteria": {}, "last_successful_search": None, "page": 1,
            "properties_in_context": [], "focused_property_id": None, "focused_property_details": None,
            "tool_choice": None,
            "tool_output": "Okay, let's start fresh. What are you looking for today?"
        }

    if user_intent == "PROJECT_NAME_SEARCH":
        logger.info("Handling PROJECT_NAME_SEARCH.")
        user_query = state["messages"][-1].content
        # Try manual cleaning first
        cleaned_query = _clean_query_for_text_search(user_query)
        if len(cleaned_query.split()) < 2 or cleaned_query == user_query.strip():
            logger.info("Manual cleaning insufficient. Using LLM to extract search phrase.")
            cleaned_query = await _llm_extract_project_name_query(state) # Use LEAN helper
        else:
            logger.info(f"Manual cleaning produced: '{cleaned_query}'")
        
        properties = state.get("properties_in_context", [])
        match = None
        for prop in properties:
            title = prop.get("title", "").lower()
            if cleaned_query.lower() in title:
                match = prop
                break
        if match:
            logger.info(f"Property '{cleaned_query}' found in context. Returning details.")
            return {
                "tool_choice": ToolChoice(tool_name="get_listing_details", tool_input={"listing_id": match["id"]}),
                "focused_property_id": match["id"]
            }
        return {
            "tool_choice": ToolChoice(tool_name="full_text_property_search", tool_input={"query": cleaned_query}),
            "search_criteria": {}, "last_successful_search": None, "page": 1,
        }

    if user_intent == "SEMANTIC_SEARCH":
        logger.info("Handling SEMANTIC_SEARCH. Routing to semantic_property_search.")
        user_query = state["messages"][-1].content
        return {
            "tool_choice": ToolChoice(tool_name="semantic_property_search", tool_input={"query": user_query}),
            "search_criteria": {}, "last_successful_search": None, "page": 1,
        }

    if user_intent in ["NEW_SEARCH", "REFINE_SEARCH", "CLARIFICATION_RESPONSE"]:
        merged_criteria = await _extract_and_merge_criteria(state) # Use LEAN helper
        if not merged_criteria.get("location"):
            logger.warning("Validation FAILED: Location is missing.")
            return {
                "search_criteria": merged_criteria,
                "tool_choice": ToolChoice(tool_name="respond_to_user", tool_input=None),
                "tool_output": "I can certainly help with that. Could you please let me know the city or area you're interested in?"
            }
        logger.info(f"Validation SUCCESS. Proceeding with tool: structured_property_search")
        return {
            "tool_choice": ToolChoice(tool_name="structured_property_search", tool_input=merged_criteria),
            "search_criteria": merged_criteria, "last_successful_search": merged_criteria, "page": 1,
        }

    if user_intent == "PAGINATION":
        if not last_search:
            logger.warning("PAGINATION intent, but no 'last_successful_search' in state.")
            return {
                "tool_choice": ToolChoice(tool_name="respond_to_user", tool_input=None),
                "tool_output": "I'm not sure what search you'd like to see more of. Could you please start a new search?"
            }
        logger.info(f"Handling PAGINATION. Re-using last search for page {current_page + 1}")
        return {
            "tool_choice": ToolChoice(tool_name="structured_property_search", tool_input=last_search),
            "page": current_page + 1,
        }

    if user_intent == "REQUEST_DETAILS":
        logger.info("Handling REQUEST_DETAILS. Attempting to find property ID.")
        property_id = await _find_property_id_from_context(
            user_message=state["messages"][-1].content,
            properties_in_context=state.get("properties_in_context", [])
        )
        if property_id:
            logger.info(f"Found property ID {property_id}. Calling get_listing_details.")
            return {
                "tool_choice": ToolChoice(tool_name="get_listing_details", tool_input={"listing_id": property_id}),
                "focused_property_id": property_id
            }
        else:
            logger.warning("Could not find matching property ID.")
            return {
                "tool_choice": ToolChoice(tool_name="respond_to_user", tool_input=None),
                "tool_output": "I'm sorry, I'm not sure which property you're referring to. Could you please be more specific?"
            }

    if user_intent == "FOLLOW_UP_QUESTION":
        logger.info("Handling FOLLOW_UP_QUESTION.")
        focused_details = state.get("focused_property_details")
        if not focused_details:
            logger.warning("FOLLOW_UP_QUESTION intent, but no 'focused_property_details'.")
            if state.get("properties_in_context"):
                 return {
                    "tool_choice": ToolChoice(tool_name="respond_to_user", tool_input=None),
                    "tool_output": "I'm not sure which of those properties you're asking about. Could you ask me to get details for one of them first? For example, 'Tell me more about the first one'."
                }
            return {
                "tool_choice": ToolChoice(tool_name="respond_to_user", tool_input=None),
                "tool_output": "I'm sorry, I'm not sure which property you're referring to. Could you start a new search or ask for details on a property?"
            }
        logger.info("Routing to synthesizer with focused property details as context.")
        details_summary = format_property_details(focused_details)
        return {
            "tool_choice": ToolChoice(tool_name="respond_to_user", tool_input=None),
            "tool_output": f"The user is asking a follow-up question about the following property:\n\n{details_summary}"
        }

    if user_intent == "GENERAL_QUERY":
        logger.info("Handling GENERAL_QUERY. Using knowledge_web_search.")
        return {
            "tool_choice": ToolChoice(
                tool_name="knowledge_web_search",
                tool_input={"query": state["messages"][-1].content}
            )
        }

    logger.error(f"Orchestrator fallback: No matching intent logic for {user_intent}")
    return {
        "tool_choice": ToolChoice(tool_name="respond_to_user", tool_input=None),
        "tool_output": "I'm sorry, I'm not sure how to handle that. Could you rephrase?"
    }


async def tool_executor_node(state: AgentState) -> Dict[str, Any]:
    """
    Node 3: Executes the tool selected by the orchestrator.
    (This node is unchanged)
    """
    logger.info("--- NODE: 3. Tool Executor ---")
    tool_choice = state.get("tool_choice")
    if not tool_choice or tool_choice.tool_name == "respond_to_user":
        logger.info("No tool to execute, or 'respond_to_user' was chosen.")
        return {"tool_output": state.get("tool_output")}

    tool_to_call = tools.get(tool_choice.tool_name)
    if not tool_to_call:
        logger.error(f"Invalid tool '{tool_choice.tool_name}' chosen.")
        return {"tool_output": f"Error: Invalid tool '{tool_choice.tool_name}' chosen."}

    tool_input = tool_choice.tool_input or {}

    if tool_choice.tool_name == "structured_property_search":
        rpc_params = {
            "location": tool_input.get("location"),
            "property_type": tool_input.get("property_type"),
            "min_price": tool_input.get("min_price"),
            "max_price": tool_input.get("max_price"),
            "bedrooms": tool_input.get("bedrooms"),
            "amenities": tool_input.get("amenities"),
            "page": state.get("page", 1),
            "limit": 5
        }
        rpc_params = {k: v for k, v in rpc_params.items() if v is not None}
        tool_input = rpc_params
        logger.info(f"Prepared input dict for structured_property_search RPC: {tool_input}")
    elif tool_choice.tool_name == "get_listing_details":
        logger.info(f"Calling get_listing_details with input: {tool_input}")
    elif tool_choice.tool_name == "knowledge_web_search":
        logger.info(f"Calling knowledge_web_search with input: {tool_input}")

    try:
        output = await tool_to_call.ainvoke(tool_input)
        logger.info(f"Tool {tool_choice.tool_name} executed successfully.")

        if tool_choice.tool_name in ["structured_property_search", "full_text_property_search", "semantic_property_search"]:
            try:
                parsed_output = json.loads(output)
                if isinstance(parsed_output, list):
                    return {
                        "tool_output": output,
                        "properties_in_context": parsed_output,
                        "properties_for_ui": parsed_output,
                    }
            except (json.JSONDecodeError, TypeError): pass

        elif tool_choice.tool_name == "get_listing_details":
            try:
                parsed_output = json.loads(output)
                if isinstance(parsed_output, dict):
                    return {"tool_output": output, "focused_property_details": parsed_output}
            except (json.JSONDecodeError, TypeError): pass

        return {"tool_output": output}

    except Exception as e:
        logger.error(f"Error executing tool {tool_choice.tool_name}: {e}", exc_info=True)
        return {"tool_output": f"Error: An error occurred while using the tool: {e}"}

async def response_synthesizer_node(state: AgentState) -> Dict[str, Any]:
    """
    Node 4 (Heavy Synthesizer): Generates the final response using the 4-part context.
    (This node is unchanged from V9, but now receives the correct data)
    """
    logger.info("--- NODE: 4. Response Synthesizer ---")
    tool_choice = state.get("tool_choice")
    tool_output = state.get("tool_output")
    properties_for_ui = state.get("properties_for_ui") or []
    
    # --- Format the 4-part context ---
    # These values were all computed in the parallel entry node
    session_memory_str = "\n".join(state.get("session_memory", []))
    summary_str = state.get("summary", "")
    recent_messages_str = _format_messages_for_prompt(state.get("recent_messages", []))
    
    tool_output_str = "" # This will be our {context}
    
    if tool_output and (not tool_choice or tool_choice.tool_name == "respond_to_user"):
        logger.info("Using pre-filled tool_output for response.")
        tool_output_str = tool_output
    elif tool_output and not tool_output.startswith("Error"):
        if tool_choice.tool_name in ["structured_property_search", "full_text_property_search", "semantic_property_search"]:
            if properties_for_ui:
                page_number = state.get("page", 1)
                tool_output_str = f"Found {len(properties_for_ui)} properties (Page {page_number}):\n{format_property_summary(properties_for_ui)}"
            else:
                tool_output_str = "I couldn't find any properties matching that description. Would you like to try a different search?"
        elif tool_choice.tool_name == "get_listing_details":
            details = state.get("focused_property_details")
            if details:
                tool_output_str = f"Here are the details for the requested property:\n{format_property_details(details)}"
            else:
                tool_output_str = "I'm sorry, I couldn't retrieve the details for that property."
        elif tool_choice.tool_name == "knowledge_web_search":
            tool_output_str = tool_output 
        else:
            tool_output_str = tool_output
    elif tool_output and tool_output.startswith("Error"):
        tool_output_str = f"I encountered an error: {tool_output}"
    else:
        logger.error("Response synthesizer fallback: No tool output or context found.")
        tool_output_str = "I'm sorry, I'm not sure what to do next. Could you rephrase?"

    logger.info(f"--- Context for Final Response ---\n{tool_output_str}...")

    # --- System prompt now uses the 4-part context ---
    system_template = """You are a helpful and intelligent real estate assistant. Your job is to generate a final, user-facing response based on the information provided.

    **CRITICAL INSTRUCTION:** You MUST use the information provided in the 'Latest Tool/Data Output' section to answer the user's question.
    - Use the 'Relevant Past Exchanges', 'Summary of Old Conversation', and 'Recent Conversation' as context to understand the user's question.
    - If the user asked a follow-up question (e.g., "what's the payment plan?"), and property details are provided, answer their question *directly* using those details in a Summarised , structured and pretty way.
    - Do NOT just repeat the raw data.
    - When information is available, present it as a short, easy-to-read summary — neatly structured, clear, and engaging, with Light Use Of emojis to highlight key points.
    - If details are found, summarize them in a clear, structured, and concise format. Use friendly and expressive emojis in section titles and/or headers to make the summary visually appealing and easy to scan.
    - If you are asking a clarification question, just ask the question.
    - Always end your response by proposing clear and helpful next steps (e.g., "Would you like more details on one of these?", "Should I refine this search?", "Would you like to see the next page?").
    """

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("user", """[Relevant Past Exchanges]:
{session_memory}

[Summary of Old Conversation]:
{summary}

[Recent Conversation]:
{recent_messages}

[Latest Tool/Data Output to Formulate Your Answer]:
{context}""")
    ])
    
    chain = prompt | llm_generator | StrOutputParser()

    response_content = await chain.ainvoke({
        "session_memory": session_memory_str or "None",
        "summary": summary_str or "None",
        "recent_messages": recent_messages_str,
        "context": tool_output_str
    })

    # Add the new AI message to the *full* message history
    final_messages = state["messages"] + [AIMessage(content=response_content)]

    logger.info(f"Final response generated. Passing back {len(properties_for_ui or [])} properties to UI.")

    return {
        "messages": final_messages, # Pass the *updated* full history
        "properties_for_ui": properties_for_ui,
        "summary": summary_str # Pass the summary (from the *start* of the turn) along
    }

async def save_memory_node(state: AgentState) -> Dict[str, Any]:
    """
    Node 5 (Final Node): Saves the last exchange to the vector store
    as a non-blocking background task.
    (Unchanged from V9)
    """
    logger.info("--- NODE: 5. Save Memory ---")
    try:
        session_id = state.get("session_id")
        
        # Get the last user query and the new bot response
        if len(state["messages"]) >= 2:
            query = state["messages"][-2].content
            response_content = state["messages"][-1].content
            
            # "Meaningfulness Gate"
            if session_id and (
                len(query.split()) > MEANINGFUL_QUERY_WORDS or
                len(response_content.split()) > MEANINGFUL_ANSWER_WORDS
            ):
                logger.info(f"Saving meaningful exchange to session {session_id}...")
                text_to_store = f"User: {query}\nBot: {response_content}"
                # Create a non-blocking task to store memory
                asyncio.create_task(global_vector_store.store_memory(session_id, text_to_store))
            else:
                logger.info("Skipping memory storage (query/response not meaningful).")
        else:
            logger.info("Skipping memory storage (not enough messages in history).")
            
    except Exception as e:
        # Do not crash the graph if saving memory fails
        logger.error(f"Error during 'Save Memory' node: {e}", exc_info=True)
    
    # This is the final node, so we return the summary to be passed
    # back to the frontend session state.
    return {"summary": state.get("summary", "")}


# --- Conditional Edges (Unchanged) ---

def should_execute_tool(state: AgentState) -> Literal["tool_executor_node", "response_synthesizer_node"]:
    """Edge 2: Decides if a tool needs to be executed."""
    tool_choice = state.get("tool_choice")
    if tool_choice and tool_choice.tool_name != "respond_to_user":
        logger.info(f"--- EDGE: Tool '{tool_choice.tool_name}' chosen, routing to Tool Executor.")
        return "tool_executor_node"

    logger.info("--- EDGE: No tool chosen or 'respond_to_user', routing to Response Synthesizer.")
    return "response_synthesizer_node"


# --- Graph Definition (UPDATED) ---

def build_graph():
    """Builds and compiles the new, optimized LangGraph agent (V10)."""
    workflow = StateGraph(AgentState)

    # 1. Add all nodes
    workflow.add_node("classify_intent_node", classify_intent_node) # Modified Entry Point
    workflow.add_node("tool_orchestrator_node", tool_orchestrator)
    workflow.add_node("tool_executor_node", tool_executor_node)
    workflow.add_node("response_synthesizer_node", response_synthesizer_node)
    workflow.add_node("save_memory_node", save_memory_node) # Final Node

    # 2. Set the new entry point
    workflow.set_entry_point("classify_intent_node")

    # 3. Define the graph flow
    workflow.add_edge("classify_intent_node", "tool_orchestrator_node")

    workflow.add_conditional_edges(
        "tool_orchestrator_node",
        should_execute_tool,
        {
            "tool_executor_node": "tool_executor_node",
            "response_synthesizer_node": "response_synthesizer_node"
        }
    )

    workflow.add_edge("tool_executor_node", "response_synthesizer_node")
    
    # 4. Add the final steps
    workflow.add_edge("response_synthesizer_node", "save_memory_node")
    workflow.add_edge("save_memory_node", END)

    return workflow.compile()

app = build_graph()