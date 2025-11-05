"""
This file implements the refactored, context-first conversational agent.
(Version 8 - Implements Session-Aware RAG Memory)

This version integrates with the ChatVectorStore to:
1.  Fetch session memory (past exchanges) in the `classify_intent` node.
2.  Inject this memory into the `response_synthesizer_node` prompt.
3.  Save new, meaningful exchanges to the vector store in `response_synthesizer_node`.
"""

import os
import json
import logging
import asyncio  # Added for non-blocking memory storage
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
from supabase import create_client, Client  # Added Supabase client

# Import the newly created tool definitions
from api_py.tools import (
    tools,
    StructuredSearchInput, ListingDetailsInput,
    TextSearchInput, SemanticSearchInput, KnowledgeSearchInput
)
# --- NEW IMPORTS for Session Memory ---
from api_py.vector_store import ChatVectorStore
from api_py.shared_embedding import embedding_engine as get_embedding_model
# --------------------------------------

# --- Environment and Global Setup ---
load_dotenv()
# Set logging level to INFO
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

# --- NEW: Global Instantiation for Vector Store ---
try:
    supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    embedding_model = get_embedding_model
    global_vector_store = ChatVectorStore(supabase_client, embedding_model)
except Exception as e:
    logger.error(f"Failed to initialize global clients: {e}", exc_info=True)
    raise

# --- NEW: Constants for "Meaningfulness Gate" ---
MEANINGFUL_QUERY_WORDS = 2
MEANINGFUL_ANSWER_WORDS = 5
# ------------------------------------------------


# --- Pydantic Models for Frontend Data Contract ---

class Message(BaseModel):
    """A single message in the chat history."""
    role: str
    content: str
    properties: Optional[List[Dict[str, Any]]] = None

class ChatRequest(BaseModel):
    """The request payload sent from the frontend."""
    messages: List[Message]
    session_state: Dict[str, Any] = {}
    session_id: str  # ADDED: Session ID from frontend

class ToolChoice(BaseModel):
    """
    A model to represent the tool selected by the orchestrator node.
    """
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

# --- Pydantic Model for Parameter Extraction (Unchanged) ---
class ExtractedSearchCriteria(BaseModel):
    """A schema for extracting structured search parameters from user text."""
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
    """Helper to convert text like '1 million' or '50 lakhs' to float."""
    text = text.lower().strip()
    match = re.search(r'([\d\.]+)', text)
    if not match:
        return None
    num = float(match.group(1))
    if 'crore' in text or 'cr' in text: return num * 10000000
    if 'lakh' in text or 'lac' in text: return num * 100000
    if 'million' in text: return num * 1000000
    if 'thousand' in text or 'k' in text: return num * 1000
    return num

# --- Helper Functions for Text Formatting (Unchanged) ---

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
    cleaned = cleaned.strip(" .,:;!?")
    return cleaned


# --- LangGraph State Definition ---

UserIntent = Literal[
    "NEW_SEARCH", "REFINE_SEARCH", "REQUEST_DETAILS",
    "FOLLOW_UP_QUESTION",
    "PAGINATION", "CLARIFICATION_RESPONSE", "META_COMMAND_RESET", "GENERAL_QUERY",
    "PROJECT_NAME_SEARCH","SEMANTIC_SEARCH"
]

class AgentState(TypedDict):
    """The full state object for the conversational agent."""
    messages: List[BaseMessage]
    user_intent: Optional[UserIntent]
    search_criteria: Dict[str, Any]
    last_successful_search: Optional[Dict[str, Any]]
    page: int
    properties_in_context: List[Dict[str, Any]]
    focused_property_id: Optional[str]
    focused_property_details: Optional[Dict[str, Any]]
    tool_choice: Optional[ToolChoice]
    tool_output: Optional[str]
    properties_for_ui: Optional[List[Dict[str, Any]]]
    # --- ADDED for Session Memory ---
    session_id: str
    session_memory: List[str]
    # --------------------------------


# --- Agent Nodes ---

async def classify_intent(state: AgentState) -> Dict[str, Any]:
    """
    Node 1: Fetches session memory AND classifies the user's intent.
    """
    logger.info("--- NODE: 1. Fetch Memory & Classify Intent ---")
    history = state["messages"]
    
    # --- NEW: Fetch Session Memory ---
    session_id = state.get("session_id")
    last_query = history[-1].content
    
    if session_id:
        logger.info(f"Session ID '{session_id}' found, searching memory...")
        similar_history_list = await global_vector_store.search_memory(session_id, last_query, k=3)
        state["session_memory"] = similar_history_list
    else:
        logger.warning("No Session ID found in state. Skipping memory search.")
        state["session_memory"] = []
    # --------------------------------

    class IntentClassifier(BaseModel):
        intent: UserIntent = Field(
            description="The single, most likely intent of the user's *last* message."
        )

    parser = PydanticOutputParser(pydantic_object=IntentClassifier)

    system_template = """You are an expert at classifying user intent within a real estate conversation.
    Analyze the final user message in the context of the conversation history.
    Classify the user's intent into ONE of the following categories:

    - NEW_SEARCH: The user is starting a new search for properties with specific criteria. (e.g., "find 3 bhk in gurgaon", "show me plots for sale")
    - REFINE_SEARCH: The user is adding, removing, or changing criteria for an *existing search*. (e.g., "only show me ones with a pool", "what about in a lower price range?")
    - REQUEST_DETAILS: The user is asking for more information about a *specific property from a list* for the *first time*. (e.g., "tell me more about the second one", "what is the exact price of Azure Heights?")
    - FOLLOW_UP_QUESTION: The user is asking a *specific question* about a property whose details are *already being discussed*. (e.g., "What is the payment plan for it?", "does it have parking?", "tell me about the location")
    - PAGINATION: The user wants to see more results from the previous search. (e.g., "show me more", "next page", "what else do you have?")
    - CLARIFICATION_RESPONSE: The user is *answering a direct question* you previously asked. (e.g., Your last message: "Which city?", User's message: "New Delhi" / "yes" / "correct")
    - META_COMMAND_RESET: The user is giving a command to restart the conversation. (e.g., "start over", "forget that", "reset")
    - GENERAL_QUERY: The user is asking a general real estate question not related to a specific listing. (e.g., "what is stamp duty?", "how do I get a home loan?")
    - PROJECT_NAME_SEARCH: The user mentions a property/project name or asks to show a property/project by name (e.g., "Azizi Venice 13", "Riverside Views - Royal 1", "show me Bluewaters Residences", "find Sobha Hartland Forest Villas").
    - SEMANTIC_SEARCH: The user query is primarily descriptive, lifestyle-based, or lacks specific structured search fields (like location, price, or bedrooms). Examples: "Show me apartments with sea views and lots of sunlight", "Homes with a modern, cozy feel", "I want something bright and airy", "Properties with mountain views", "Houses good for families and pets".

    **Context is CRITICAL:**
    - If the bot just showed details for "Property A" and the user asks "does it have a pool?", the intent is **FOLLOW_UP_QUESTION**.
    - If the bot just showed a *list* of properties and the user asks "does the first one have a pool?", the intent is **REQUEST_DETAILS**.
    - If the user asks "show me places with a pool", the intent is **REFINE_SEARCH**.
    - If the user mentions the name of a property or project (and not a general search or criteria), use **PROJECT_NAME_SEARCH**.
    - If the user message is mainly descriptive, lifestyle-oriented, or lacks structured fields, use **SEMANTIC_SEARCH**.

    {format_instructions}
    """

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("human", "Conversation History:\n{history}\n\nUser's final message: '{last_message}'\n\nClassification:")
    ])

    chain = prompt | llm_router | parser

    history_str = "\n".join([f"{m.type}: {m.content}" for m in history])
    last_message = history[-1].content

    try:
        result = await chain.ainvoke({
            "history": history_str,
            "last_message": last_message,
            "format_instructions": parser.get_format_instructions()
        })
        logger.info(f"Intent classified as: {result.intent}")
        return {"user_intent": result.intent, "session_memory": state["session_memory"]}
    except Exception as e:
        logger.error(f"Error during intent classification: {e}")
        return {"user_intent": "GENERAL_QUERY", "session_memory": state["session_memory"]}


async def _extract_and_merge_criteria(
    history: List[BaseMessage],
    current_criteria: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Runs a dedicated LLM chain to extract structured parameters from the
    latest user message *in context* and merge them with the existing criteria.
    (This function is unchanged)
    """
    logger.info("--- Helper: _extract_and_merge_criteria (Context-Aware) ---")

    parser = PydanticOutputParser(pydantic_object=ExtractedSearchCriteria)

    system_template = """You are an expert at extracting structured real estate data from a conversation.
    Your goal is to update search parameters based on the *User's final message*.

    1.  Analyze the "Conversation History" to understand the context.
    2.  Pay close attention to the *Bot's last question* (if any).
    3.  Analyze the "User's final message" as the *answer* to that question.

    **CRITICAL RULES:**
    1.  If the bot asked a question (e.g., "Which location?") and the user answers ("Dubai Marina"), extract that as the parameter.
    2.  If the bot *suggested* a parameter (e.g., "Did you mean 2 bedrooms?") and the user confirms ("yes", "correct", "that's right"), you MUST extract that suggested parameter.
    3.  Convert text to the correct data type.
    4.  `bedrooms`: '2bhk', '2 bedroom', 'two bed' -> `bedrooms: 2`
    5.  `price`:
        - 'under 1 million', 'less than 10 lakhs' -> `max_price: 1000000`
        - 'over 50 lakhs', 'more than 5 million' -> `min_price: 5000000`
        - 'between 80 lakhs and 1 crore' -> `min_price: 8000000`, `max_price: 10000000`
        - 'around 1.5 cr' -> `min_price: 14000000`, `max_price: 16000000`
    6.  If a value is not mentioned or implied by context, omit the key.

    {format_instructions}
    """

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("human", "Conversation History (Bot's last message is most important):\n{history}\n\nUser's final message: '{last_message}'\n\nExtracted Parameters:")
    ])

    chain = prompt | llm_router | parser

    history_str = "\n".join([f"{m.type}: {m.content}" for m in history])
    last_message = history[-1].content

    try:
        extracted_data = await chain.ainvoke({
            "history": history_str,
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

async def _find_property_id_from_context(
    user_message: str,
    properties_in_context: List[Dict[str, Any]]
) -> Optional[str]:
    """
    Uses an LLM to find the specific property ID the user is referring to.
    (This function is unchanged)
    """
    logger.info("--- Helper: _find_property_id_from_context ---")
    if not properties_in_context:
        logger.warning("No properties in context to search for details.")
        return None
    property_summary = format_property_summary(properties_in_context)
    class PropertyIDMatcher(BaseModel):
        property_id: Optional[str] = Field(
            default=None,
            description="The single property ID (e.g., 'p-1a2b3c') the user is referring to."
        )
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


async def _llm_extract_project_name_query(history: list, user_query: str) -> str:
    """
    Use an LLM to extract the property/project name or search phrase from the user's message.
    (This function is unchanged)
    """
    prompt = ChatPromptTemplate.from_messages([
        ("system", "You are an expert assistant that extracts only the property or project name from user queries for real estate searches. Remove all polite phrases, commands, and only return the search phrase to be used directly in a property database search. Examples:\n- Input: 'Show me Riverside Views - Royal 1 by Damac Properties' => Output: 'Riverside Views - Royal 1 by Damac Properties'\n- Input: 'Find Azizi Venice 13' => Output: 'Azizi Venice 13'\n- Input: 'Search for Bluewaters Residences' => Output: 'Bluewaters Residences'\n- Input: 'Give me Sobha Hartland Forest Villas' => Output: 'Sobha Hartland Forest Villas'\nIf the input is already just a project or property name, return it as is. Do not add any extra words or formatting."),
        ("human", "Conversation History:\n{history}\n\nUser's final message: '{user_query}'\n\nExtracted Search Phrase:")
    ])
    chain = prompt | llm_router | StrOutputParser()
    history_str = "\n".join([f"{m.type}: {m.content}" for m in history])
    response = await chain.ainvoke({"history": history_str, "user_query": user_query})
    return response.strip(" \n.:;!?\"'")


async def tool_orchestrator(state: AgentState) -> Dict[str, Any]:
    """
    Node 2: Selects the correct tool AND parameters.
    (This node is unchanged)
    """
    logger.info(f"--- NODE: 2. Tool Orchestrator (Intent: {state.get('user_intent')}) ---")
    user_intent = state.get("user_intent")
    current_criteria = state.get("search_criteria", {})
    last_search = state.get("last_successful_search", {})
    current_page = state.get("page", 1)

    if user_intent == "META_COMMAND_RESET":
        logger.info("Handling META_COMMAND_RESET: Clearing state.")
        return {
            "search_criteria": {}, "last_successful_search": None, "page": 1,
            "properties_in_context": [], "focused_property_id": None, "focused_property_details": None,
            "tool_choice": None,
            "tool_output": "Okay, let's start fresh. What are you looking for today?"
        }

    if user_intent == "PROJECT_NAME_SEARCH":
        logger.info("Handling PROJECT_NAME_SEARCH.")
        user_query = state["messages"][-1].content
        cleaned_query = _clean_query_for_text_search(user_query)
        if len(cleaned_query.split()) < 2 or cleaned_query == user_query.strip():
            logger.info("Manual cleaning insufficient. Using LLM to extract search phrase.")
            cleaned_query = await _llm_extract_project_name_query(state["messages"], user_query)
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
        merged_criteria = await _extract_and_merge_criteria(state["messages"], current_criteria)
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
    Node 4: Generates the final response AND saves memory.
    """
    logger.info("--- NODE: 4. Response Synthesizer ---")
    tool_choice = state.get("tool_choice")
    tool_output = state.get("tool_output")
    properties_for_ui = state.get("properties_for_ui") or []
    
    # --- NEW: Format session memory for the prompt ---
    session_memory_str = "\n".join(state.get("session_memory", []))
    if session_memory_str:
        logger.info(f"Injecting {len(state.get('session_memory', []))} memories into prompt.")
        session_memory_context = f"Relevant past exchanges from this session:\n{session_memory_str}\n\n"
    else:
        session_memory_context = ""
    # ------------------------------------------------

    context_for_llm = ""

    if tool_output and (not tool_choice or tool_choice.tool_name == "respond_to_user"):
        logger.info("Using pre-filled tool_output for response.")
        context_for_llm = tool_output
    elif tool_output and not tool_output.startswith("Error"):
        if tool_choice.tool_name in ["structured_property_search", "full_text_property_search", "semantic_property_search"]:
            if properties_for_ui:
                page_number = state.get("page", 1)
                context_for_llm = f"Found {len(properties_for_ui)} properties (Page {page_number}):\n{format_property_summary(properties_for_ui)}"
            else:
                context_for_llm = "I couldn't find any properties matching that description. Would you like to try a different search?"
        elif tool_choice.tool_name == "get_listing_details":
            details = state.get("focused_property_details")
            if details:
                context_for_llm = f"Here are the details for the requested property:\n{format_property_details(details)}"
            else:
                context_for_llm = "I'm sorry, I couldn't retrieve the details for that property."
        elif tool_choice.tool_name == "knowledge_web_search":
            context_for_llm = tool_output 
        else:
            context_for_llm = tool_output
    elif tool_output and tool_output.startswith("Error"):
        context_for_llm = f"I encountered an error: {tool_output}"
    else:
        logger.error("Response synthesizer fallback: No tool output or context found.")
        context_for_llm = "I'm sorry, I'm not sure what to do next. Could you rephrase?"

    logger.info(f"--- Context for Final Response ---\n{context_for_llm}...")

    # --- UPDATED: System prompt now includes session_memory ---
    system_template = """You are a helpful and intelligent real estate assistant. Your job is to generate a final, user-facing response based on the information provided.

    **CRITICAL INSTRUCTION:** You MUST use the information provided in the 'Latest Information' section to answer the user's question.
    - If 'Relevant past exchanges' are provided, use them as context for your answer.
    - If the user asked a follow-up question (e.g., "what's the payment plan?"), and property details are provided, answer their question *directly* using those details in a structured and pretty way.
    - Do NOT just repeat the raw data.
    - When information is available, present it as a short, easy-to-read summary — neatly structured, clear, and engaging, with Light Use Of emojis to highlight key points.
    - If details are found, summarize them in a clear, structured, and concise format. Use friendly and expressive emojis in section titles and/or headers to make the summary visually appealing and easy to scan.
    - If you are asking a clarification question, just ask the question.
    - Always end your response by proposing clear and helpful next steps (e.g., "Would you like more details on one of these?", "Should I refine this search?", "Would you like to see the next page?").
    """

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_template),
        ("user", "Conversation History:\n{history}\n\n{session_memory}Latest Information to Formulate Your Answer:\n{context}")
    ])
    # -------------------------------------------------------
    
    chain = prompt | llm_generator | StrOutputParser()

    history_str = "\n".join([f"{m.type}: {m.content}" for m in state["messages"]])
    response_content = await chain.ainvoke({
        "history": history_str,
        "context": context_for_llm,
        "session_memory": session_memory_context  # Pass in the formatted memory
    })

    final_messages = state["messages"] + [AIMessage(content=response_content)]

    # --- NEW: "Meaningfulness Gate" and Save Memory Logic ---
    try:
        session_id = state.get("session_id")
        query = state["messages"][-1].content
        
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
    except Exception as e:
        logger.error(f"Error during 'Save Memory' logic: {e}", exc_info=True)
    # ------------------------------------------------------

    logger.info(f"Final response generated. Passing back {len(properties_for_ui or [])} properties to UI.")

    return {
        "messages": final_messages,
        "properties_for_ui": properties_for_ui
    }

# --- Conditional Edges (Unchanged) ---

def should_execute_tool(state: AgentState) -> Literal["tool_executor_node", "response_synthesizer_node"]:
    """Edge 2: Decides if a tool needs to be executed."""
    tool_choice = state.get("tool_choice")
    if tool_choice and tool_choice.tool_name != "respond_to_user":
        logger.info(f"--- EDGE: Tool '{tool_choice.tool_name}' chosen, routing to Tool Executor.")
        return "tool_executor_node"

    logger.info("--- EDGE: No tool chosen or 'respond_to_user', routing to Response Synthesizer.")
    return "response_synthesizer_node"


# --- Graph Definition (Unchanged) ---
from langgraph.graph import StateGraph, END

def build_graph():
    """Builds and compiles the new LangGraph agent."""
    workflow = StateGraph(AgentState)

    workflow.add_node("classify_intent_node", classify_intent)
    workflow.add_node("tool_orchestrator_node", tool_orchestrator)
    workflow.add_node("tool_executor_node", tool_executor_node)
    workflow.add_node("response_synthesizer_node", response_synthesizer_node)

    workflow.set_entry_point("classify_intent_node")
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
    workflow.add_edge("response_synthesizer_node", END)

    return workflow.compile()

app = build_graph()
