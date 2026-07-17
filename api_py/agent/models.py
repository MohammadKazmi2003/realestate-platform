"""
Agent data models.
Defines the state, request/response, and type structures for the agent.
"""

from typing import Any, Optional, TypedDict
from pydantic import BaseModel, Field
from typing import Literal


# --- Request/Response Models ---

class Message(BaseModel):
    """A single message in the chat history."""
    role: str
    content: str
    properties: Optional[list[dict[str, Any]]] = None


class ChatRequest(BaseModel):
    """The request payload sent from the frontend."""
    messages: list[Message]
    session_state: dict[str, Any] = {}
    session_id: str


class ChatResponse(BaseModel):
    """The response payload sent back to the frontend."""
    text_response: str
    properties: list[dict[str, Any]] = []
    session_state: dict[str, Any] = {}


# --- Agent State ---

UserIntent = Literal[
    "NEW_SEARCH",
    "REFINE_SEARCH",
    "REQUEST_DETAILS",
    "FOLLOW_UP_QUESTION",
    "PAGINATION",
    "CLARIFICATION_RESPONSE",
    "META_COMMAND_RESET",
    "GENERAL_QUERY",
    "PROJECT_NAME_SEARCH",
    "SEMANTIC_SEARCH",
]


class AgentState(TypedDict, total=False):
    """Simplified state for the MCP agent."""
    messages: list[dict[str, Any]]
    intent: Optional[str]
    search_criteria: dict[str, Any]
    last_successful_search: Optional[dict[str, Any]]
    page: int
    properties_in_context: list[dict[str, Any]]
    projects_in_context: list[dict[str, Any]]
    focused_property_id: Optional[str]
    focused_property_details: Optional[dict[str, Any]]
    properties_for_ui: Optional[list[dict[str, Any]]]
    session_id: str
    session_memory: list[str]


# --- Tool Choice ---

TOOL_NAMES = [
    "structured_property_search",
    "full_text_property_search",
    "semantic_property_search",
    "get_listing_details",
    "knowledge_web_search",
    "project_text_search",
    "get_project_details_by_slug",
    "respond_to_user",
]


class ToolChoice(BaseModel):
    """Represents the tool selected by the orchestrator."""
    tool_name: Literal[*TOOL_NAMES] = Field(
        description="The name of the tool to execute."
    )
    tool_input: Optional[dict[str, Any]] = Field(
        default=None,
        description="The input parameters for the chosen tool.",
    )
