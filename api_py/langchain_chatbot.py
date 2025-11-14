"""
This file implements the refactored, context-first conversational agent.
(Version 11 - Master Orchestrator)

This version solves the API call amplification (429 errors) and performance
issues of V10. It replaces the multi-step parsing (classify_intent, 
tool_orchestrator, helpers) with a single, powerful orchestrator node.

Key Changes:
1.  **2-Call Design:** Reduces blocking LLM calls from 3-4 to 2.
    - Call 1: `master_orchestrator_node` (Parses query & routes to tools).
    - Call 2: `response_synthesizer_node` (Generates final text).
2.  **Consolidated Parsing:** A new `OrchestrationDecision` Pydantic model
    allows a single LLM call to replace `classify_intent`, 
    `_extract_and_merge_criteria`, `_find_property_id_from_context`, and 
    `_llm_extract_project_name_query`.
3.  **Non-Blocking Summarization:** Summarization now runs as a non-blocking
    `asyncio.create_task()`, completely removing it from the user-facing
    latency path.
4.  **Improved Accuracy:** The new orchestrator prompt receives all context
    (recent messages, properties on screen, focused details) at once,
    allowing it to make a much more accurate, holistic decision.
"""

import os
import json
import logging
import asyncio  # For parallel execution & non-blocking tasks
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

# --- Pydantic Models ---

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
    """(Unchanged) A schema for extracting structured search parameters from user text."""
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


class OrchestrationDecision(BaseModel):
    """
    The single, consolidated routing and extraction model (V11).
    The LLM's job is to analyze the user's query and populate *only one*
    of the following fields based on the user's intent.
    """
    
    search_criteria: Optional[ExtractedSearchCriteria] = Field(
        default=None, 
        description="Fill this to start a new search or refine an existing search. Captures location, price, bedrooms, etc."
    )
    
    request_details_id: Optional[str] = Field(
        default=None, 
        description="Fill with the *exact* property ID (e.g., 'p-1a2b3c') if the user is asking for details about a specific property from the 'Properties on Screen' list."
    )
    
    pagination: Optional[Literal["next_page"]] = Field(
        default=None, 
        description="Fill this *only* if the user asks to see more results (e.g., 'next page', 'show me more')."
    )
    
    text_search_query: Optional[str] = Field(
        default=None, 
        description="Fill this *only* if the user searches for a specific project name (e.g., 'Sobha One', 'Emaar South')."
    )
    
    semantic_search_query: Optional[str] = Field(
        default=None, 
        description="Fill this for descriptive, lifestyle-based queries (e.g., 'a quiet home with a sea view')."
    )

    knowledge_query: Optional[str] = Field(
        default=None, 
        description="Fill this if the user asks a general knowledge question (e.g., 'what is stamp duty?', 'how do I get a home loan?')."
    )

    follow_up_response: bool = Field(
        default=False, 
        description="Set to 'true' if the user is asking a follow-up question about the property whose 'Focused Property Details' are already on screen (e.g., 'does it have a pool?')."
    )

    meta_command: Optional[Literal["reset"]] = Field(
        default=None,
        description="Set to 'reset' if the user wants to start over (e.g., 'reset', 'start over')."
    )
    
    direct_response: Optional[str] = Field(
        default=None, 
        description="A simple, direct response if no tools are needed (e.g., for 'hello', 'thank you', 'ok')."
    )


# --- Helper Functions ---

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

def format_property_details(details: Optional[Dict[str, Any]]) -> str:
    if not details: return "No details available."
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
        elif isinstance(value, dict) and value:
            output_lines.append(f"\n{formatted_key}:")
            for sub_key, sub_val in value.items():
                formatted_sub_val = format_value(sub_val)
                if formatted_sub_val: output_lines.append(f"  {sub_key.replace('_', ' ').title()}: {formatted_sub_val}")
    return "\n".join(output_lines)


def _format_messages_for_prompt(messages: List[BaseMessage]) -> str:
    """Converts a list of BaseMessages into a simple string."""
    return "\n".join([f"{m.type}: {m.content}" for m in messages])

# --- NEW HELPER FUNCTION (V11.3) ---
def sanitize_for_ascii_headers(text: Any) -> str:
    """
    Forces a string to ASCII, replacing non-ASCII chars.
    This prevents UnicodeEncodeError in httpx headers used by the Groq client.
    """
    if not isinstance(text, str):
        text = str(text)
    # Use 'replace' to be safe. 'A façade' becomes 'A fa?ade'
    # This ensures the string can be safely passed.
    return text.encode('ascii', 'replace').decode('ascii')
# --- END NEW HELPER FUNCTION ---

async def _summarize_history_chain(messages_to_summarize: List[BaseMessage], existing_summary: str) -> str:
    """
    A dedicated chain to summarize old messages.
    It now appends to the existing summary.
    """
    if not messages_to_summarize:
        return existing_summary
        
    logger.info(f"Invoking summarizer for {len(messages_to_summarize)} new messages.")
    
    summarizer_prompt = ChatPromptTemplate.from_messages([
        ("system", "You are an expert at summarizing conversations. Create a concise, third-person summary of the *new messages* below, appending it to the 'Existing Summary'. Focus on key decisions, search parameters, and properties discussed. Do not repeat information already in the summary."),
        ("user", "Existing Summary:\n{existing_summary}\n\nNew Messages to Summarize:\n{history}\n\nUpdated Summary:")
    ])
    
    summarizer_chain = summarizer_prompt | llm_summarizer | StrOutputParser()
    
    history_str = _format_messages_for_prompt(messages_to_summarize)
    
    try:
        summary = await summarizer_chain.ainvoke({ # <-- BUG FIX: This was 'chain.ainvoke'
            "existing_summary": sanitize_for_ascii_headers(existing_summary or "None"),
            "history": sanitize_for_ascii_headers(history_str)
        })
        return summary
    except Exception as e:
        logger.error(f"Error during summarization: {e}")
        return existing_summary # Return old summary on failure

# --- LangGraph State Definition ---

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
    search_criteria: Dict[str, Any]
    last_successful_search: Optional[Dict[str, Any]]
    page: int
    
    # --- Property/Tool State ---
    properties_in_context: List[Dict[str, Any]] # CRITICAL: For intent accuracy
    focused_property_id: Optional[str]
    focused_property_details: Optional[Dict[str, Any]]
    tool_choice: Optional[ToolChoice]
    properties_for_ui: Optional[List[Dict[str, Any]]]


# --- Agent Nodes (REFACTORED V11) ---

async def master_orchestrator_node(state: AgentState) -> Dict[str, Any]:
    """
    Node 1 (NEW Entry Point): The "Master Router".
    Runs 3 tasks in parallel:
    1.  Orchestrator LLM (await): Decides *everything* (intent, params, route).
    2.  RAG Search (await): Gets context for the synthesizer.
    3.  Summarization (async): Runs in the background, non-blocking.
    """
    logger.info("--- NODE: 1. Master Orchestrator (V11) ---")
    
    # --- 1. Clear stale data from previous turn ---
    state["tool_output"] = None
    state["properties_for_ui"] = None
    
    messages = state["messages"]
    last_query = messages[-1].content
    session_id = state["session_id"]
    
    # --- 2. Prepare context for all parallel tasks ---
    recent_messages = messages[-RECENT_MESSAGE_COUNT:]
    recent_messages_str = _format_messages_for_prompt(recent_messages)
    
    properties_on_screen_str = format_property_summary(state.get("properties_in_context", []))
    focused_property_details_str = format_property_details(state.get("focused_property_details"))
    
    # --- 3. Define the parallel tasks ---

    async def task_1_run_orchestrator_llm() -> OrchestrationDecision:
        """
        Runs the single, consolidated parsing and routing LLM call.
        This is LLM Call #1.
        """
        logger.info("Orchestrator task: Running main LLM router...")
        
        orchestrator_prompt_template = """You are an expert real estate assistant orchestrator.
        Your goal is to analyze the user's latest query in the context of the conversation and decide on the *single* next action.
        You MUST populate *only one* field in the JSON output.

        **CONTEXT:**
        1.  [Recent History]: The immediate past conversation.
        2.  [Properties on Screen]: A list of properties the user is *currently* looking at.
        3.  [Focused Property Details]: Full details of a property the user has *already* asked about.

        **ROUTING RULES (Fill *only one* field):**

        1.  `search_criteria`:
            - Use this for NEW searches (e.g., "find 3bhk in Dubai Marina").
            - Use this for REFINING searches (e.g., "what about under 2M?", "only with a pool").
            - Extract all parameters: `location`, `property_type`, `min_price`, `max_price`, `bedrooms`.

        2.  `request_details_id`:
            - Use this if the user asks for details on a *specific property* from the [Properties on Screen] list.
            - The user might say "tell me about the first one" (Index 1) or "details on Sobha One" (Title).
            - You MUST return the corresponding `ID` (e.g., 'p-1a2b3c') from the list.

        3.  `follow_up_response`:
            - Set to `true` if [Focused Property Details] is *not empty* and the user asks a follow-up question about it (e.g., "what's the payment plan?", "does it have parking?").

        4.  `text_search_query`:
            - Use this *only* if the user is searching for a *specific project name* (e.g., "find Sobha Hartland", "show me Azizi Venice").
        
        5.  `semantic_search_query`:
            - Use this for *descriptive, lifestyle* queries (e.g., "I want a quiet home with a sea view", "a bright, airy apartment").

        6.  `pagination`:
            - Set to "next_page" *only* if the user asks to see more results (e.g., "next page", "show me more").

        7.  `knowledge_query`:
            - Use this for general questions *not* about properties (e.g., "what is stamp duty?", "how do I get a home loan?").

        8.  `meta_command`:
            - Set to "reset" if the user wants to start over (e.g., "reset", "start over").

        9.  `direct_response`:
            - Use this for simple greetings or closings (e.g., "hello", "thanks", "ok"). Provide the response text.

        **Example 1 (New Search):**
        User: "Find 2 bedroom apartments in Dubai Marina under 3M AED"
        Output: {{ "search_criteria": {{ "location": "Dubai Marina", "property_type": "apartment", "bedrooms": 2, "max_price": 3000000 }} }}

        **Example 2 (Request Details):**
        [Properties on Screen]: "Index: 1, ID: p-abc1, Title: Sobha One..."
        User: "tell me more about the first one"
        Output: {{ "request_details_id": "p-abc1" }}
        
        **Example 3 (Follow-up):**
        [Focused Property Details]: "Title: Sobha One, Price: 2.5M, Beds: 2..."
        User: "does it have a swimming pool?"
        Output: {{ "follow_up_response": true }}
        """
        
        prompt = ChatPromptTemplate.from_messages([
            ("system", orchestrator_prompt_template),
            ("human", """**CONTEXT:**
            [Recent History]:
            {recent_messages}
            
            [Properties on Screen]:
            {properties_on_screen}
            
            [Focused Property Details]:
            {focused_property_details}
            
            **User's final message:**
            "{last_message}"
            
            **JSON Output (fill only ONE key):**""")
        ])
        
        # Use .with_structured_output to get a guaranteed JSON object
        chain = prompt | llm_router.with_structured_output(OrchestrationDecision)
        
        try:
            # --- V11.3 FIX: Sanitize all inputs ---
            result = await chain.ainvoke({
                "recent_messages": sanitize_for_ascii_headers(recent_messages_str),
                "properties_on_screen": sanitize_for_ascii_headers(properties_on_screen_str or "None"),
                "focused_property_details": sanitize_for_ascii_headers(focused_property_details_str or "None"),
                "last_message": sanitize_for_ascii_headers(last_query)
            })
            return result
        except Exception as e:
            logger.error(f"Error during main orchestration LLM call: {e}")
            # Failsafe: return a decision that leads to a simple response
            return OrchestrationDecision(direct_response="I'm sorry, I'm having a little trouble understanding. Could you rephrase?")


    async def task_2_run_rag_search() -> List[str]:
        """
        Fetches relevant past exchanges for the *final synthesizer*.
        """
        if session_id:
            logger.info("RAG task: Searching memory...")
            try:
                return await global_vector_store.search_memory(session_id, last_query, k=3)
            except Exception as e:
                logger.error(f"RAG task: Error during memory search: {e}")
                return []
        else:
            logger.warning("RAG task: No Session ID. Skipping memory search.")
            return []

    def task_3_run_summarization(current_summary: str):
        """
        Kicks off a *non-blocking* background task to summarize.
        """
        old_messages = messages[:-RECENT_MESSAGE_COUNT]
        if len(messages) > HISTORY_THRESHOLD and old_messages:
            logger.info(f"Summarization task: Kicking off background summary for {len(old_messages)} messages.")
            # We create the task but don't await it.
            # Its result will be saved to the session by the *next* turn's invocation.
            asyncio.create_task(_summarize_history_chain(old_messages, current_summary))
        else:
            logger.info("Summarization task: No summary needed.")

    # --- 4. Run tasks ---
    
    # Get the summary from the *start* of this turn
    summary_from_start_of_turn = state.get("summary", "")
    
    # Run the non-blocking summary task first (it just starts and returns)
    task_3_run_summarization(summary_from_start_of_turn)
    
    # Run the two blocking tasks (LLM and RAG) in parallel
    try:
        decision, rag_results = await asyncio.gather(
            task_1_run_orchestrator_llm(),
            task_2_run_rag_search()
        )
    except Exception as e:
        logger.error(f"Critical error in parallel execution: {e}", exc_info=True)
        decision = OrchestrationDecision(direct_response="I'm sorry, I've encountered an error. Could you try that again?")
        rag_results = []
    
    # --- 5. Process results and populate state for the next node ---
    
    # This is the full context that will be passed to the synthesizer
    output_state = {
        "session_memory": rag_results,
        "summary": summary_from_start_of_turn, # Use the summary from the start
        "recent_messages": recent_messages,
        "tool_choice": None, # Default to no tool
    }

    if decision.search_criteria:
        logger.info(f"Orchestrator decided: NEW/REFINE SEARCH with criteria: {decision.search_criteria.model_dump()}")
        criteria_dict = decision.search_criteria.model_dump()
        output_state["search_criteria"] = {**state.get("search_criteria", {}), **criteria_dict}
        output_state["last_successful_search"] = output_state["search_criteria"]
        output_state["page"] = 1 # Reset page on new search
        output_state["tool_choice"] = ToolChoice(tool_name="structured_property_search", tool_input=output_state["search_criteria"])

    elif decision.request_details_id:
        logger.info(f"Orchestrator decided: REQUEST DETAILS for ID: {decision.request_details_id}")
        output_state["focused_property_id"] = decision.request_details_id
        output_state["tool_choice"] = ToolChoice(tool_name="get_listing_details", tool_input={"listing_id": decision.request_details_id})

    elif decision.pagination == "next_page":
        logger.info("Orchestrator decided: PAGINATION")
        last_search = state.get("last_successful_search")
        if not last_search:
            output_state["tool_choice"] = ToolChoice(tool_name="respond_to_user", tool_input=None)
            output_state["tool_output"] = "I'm not sure what search you'd like to see more of. Could you please start a new search?"
        else:
            current_page = state.get("page", 1) + 1
            output_state["page"] = current_page
            output_state["tool_choice"] = ToolChoice(tool_name="structured_property_search", tool_input=last_search)

    elif decision.text_search_query:
        logger.info(f"Orchestrator decided: TEXT SEARCH for: {decision.text_search_query}")
        output_state["page"] = 1
        output_state["tool_choice"] = ToolChoice(tool_name="full_text_property_search", tool_input={"query": decision.text_search_query})

    elif decision.semantic_search_query:
        logger.info(f"Orchestrator decided: SEMANTIC SEARCH for: {decision.semantic_search_query}")
        output_state["page"] = 1
        output_state["tool_choice"] = ToolChoice(tool_name="semantic_property_search", tool_input={"query": decision.semantic_search_query})

    elif decision.knowledge_query:
        logger.info(f"Orchestrator decided: KNOWLEDGE QUERY: {decision.knowledge_query}")
        output_state["tool_choice"] = ToolChoice(tool_name="knowledge_web_search", tool_input={"query": decision.knowledge_query})

    elif decision.follow_up_response:
        logger.info("Orchestrator decided: FOLLOW UP RESPONSE")
        output_state["tool_choice"] = ToolChoice(tool_name="respond_to_user", tool_input=None)
        # --- THIS IS THE FIX (V11.2) ---
        # Instead of passing the giant formatted string blob, we pass a 
        # structured JSON instruction. The synthesizer will detect this
        # and use a leaner, extraction-focused prompt.
        try:
            output_state["tool_output"] = json.dumps({
                "task": "follow_up_question_on_json",
                "user_query": last_query,
                "property_json": state.get("focused_property_details") 
            })
        except TypeError as e:
            logger.error(f"Failed to serialize property_details for follow-up: {e}")
            # Failsafe if JSON is un-serializable (though it should be)
            output_state["tool_output"] = "I'm sorry, I've run into an issue retrieving those details. Could you ask me to show the details for that property again?"
        # --- END FIX ---

    elif decision.meta_command == "reset":
        logger.info("Orchestrator decided: META COMMAND RESET")
        output_state["summary"] = "" # Clear summary
        output_state["recent_messages"] = [messages[-1]] # Keep only last user message
        output_state["search_criteria"] = {}
        output_state["last_successful_search"] = None
        output_state["page"] = 1
        output_state["properties_in_context"] = []
        output_state["focused_property_id"] = None
        output_state["focused_property_details"] = None
        output_state["tool_choice"] = ToolChoice(tool_name="respond_to_user", tool_input=None)
        output_state["tool_output"] = "Okay, let's start fresh. What are you looking for today?"

    elif decision.direct_response:
        logger.info(f"Orchestrator decided: DIRECT RESPONSE: {decision.direct_response}")
        output_state["tool_choice"] = ToolChoice(tool_name="respond_to_user", tool_input=None)
        output_state["tool_output"] = decision.direct_response
        
    else:
        logger.warning("Orchestrator FAILED to make a decision. Defaulting to direct response.")
        output_state["tool_choice"] = ToolChoice(tool_name="respond_to_user", tool_input=None)
        output_state["tool_output"] = "I'm sorry, I'm not sure how to handle that. Could you rephrase?"

    return output_state


async def tool_executor_node(state: AgentState) -> Dict[str, Any]:
    """
    Node 2: Executes the tool selected by the orchestrator.
    (This node is unchanged from V10.1)
    """
    logger.info("--- NODE: 2. Tool Executor ---")
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
    Node 3: (Heavy Synthesizer) Generates the final response.
    This is LLM Call #2.
    
    V11.2 Update: This node now has two paths:
    1.  "Heavy Path": The default, for summarizing new searches/details.
    2.  "Lean Path": A new, lean prompt for follow-up questions
        to prevent 429 errors from massive context.
    """
    logger.info("--- NODE: 3. Response Synthesizer ---")
    tool_choice = state.get("tool_choice")
    tool_output = state.get("tool_output")
    properties_for_ui = state.get("properties_for_ui") or []
    
    # --- Format the 4-part context ---
    session_memory_str = "\n".join(state.get("session_memory", []))
    summary_str = state.get("summary", "")
    recent_messages_str = _format_messages_for_prompt(state.get("recent_messages", []))
    
    tool_output_str = "" # This will be our {context}
    
    # --- NEW: V11.2 Lean Path (Follow-up) ---
    try:
        # Check if tool_output is our special JSON task
        tool_data = json.loads(tool_output)
        if isinstance(tool_data, dict) and tool_data.get("task") == "follow_up_question_on_json":
            logger.info("Synthesizer: Using LEAN path for follow-up question.")
            
            # This is a lean, extraction-focused prompt.
            # It's much smaller and cheaper than the "heavy" synthesizer.
            lean_prompt_template = """You are a helpful assistant.
            The user is asking a specific question about a property they are already viewing.
            Your job is to find the specific answer from the provided Property JSON and present it clearly with Light Use Of emojis to highlight key points and Easy To Scan.
            Do not summarize the whole property. Just answer the question in clear, structured, and concise format. Use friendly and expressive emojis in section titles and/or headers to make the summary visually appealing and easy to scan..
            
            Property JSON:
            {property_json}
            
            User Question:
            {user_query}
            
            Specific Answer:"""
            
            prompt = ChatPromptTemplate.from_template(lean_prompt_template)
            chain = prompt | llm_generator | StrOutputParser()
            
            # --- V11.3 FIX: Sanitize all inputs ---
            response_content = await chain.ainvoke({
                "property_json": sanitize_for_ascii_headers(json.dumps(tool_data.get("property_json"), indent=2)),
                "user_query": sanitize_for_ascii_headers(tool_data.get("user_query"))
            })
            
            # Add the new AI message to the *full* message history
            final_messages = state["messages"] + [AIMessage(content=response_content)]
            logger.info("Final response generated (lean path).")
            
            return {
                "messages": final_messages,
                "properties_for_ui": [], # No new properties to show
                "summary": summary_str 
            }
            
    except (json.JSONDecodeError, TypeError, AttributeError):
        # It's not our special JSON task, proceed to the "heavy path"
        logger.info("Synthesizer: Using HEAVY path.")
        pass
    # --- END: V11.2 Lean Path ---

    # --- V11.2 Heavy Path (Default) ---
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
    - If the user asked a follow-up question (e.g., "what's the payment plan?"), and property details are provided, answer their question *directly* using those details in a structured and pretty way.
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

    # --- V11.3 FIX: Sanitize all inputs ---
    response_content = await chain.ainvoke({
        "session_memory": sanitize_for_ascii_headers(session_memory_str or "None"),
        "summary": sanitize_for_ascii_headers(summary_str or "None"),
        "recent_messages": sanitize_for_ascii_headers(recent_messages_str),
        "context": sanitize_for_ascii_headers(tool_output_str)
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
    Node 4 (Final Node): Saves the last exchange to the vector store
    as a non-blocking background task.
    (Unchanged from V10.1)
    """
    logger.info("--- NODE: 4. Save Memory ---")
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


# --- Graph Definition (UPDATED V11) ---

def build_graph():
    """Builds and compiles the new, optimized LangGraph agent (V11)."""
    workflow = StateGraph(AgentState)

    # 1. Add all nodes
    workflow.add_node("master_orchestrator_node", master_orchestrator_node) # New Entry Point
    workflow.add_node("tool_executor_node", tool_executor_node)
    workflow.add_node("response_synthesizer_node", response_synthesizer_node)
    workflow.add_node("save_memory_node", save_memory_node) # Final Node

    # 2. Set the new entry point
    workflow.set_entry_point("master_orchestrator_node")

    # 3. Define the graph flow
    workflow.add_conditional_edges(
        "master_orchestrator_node",
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