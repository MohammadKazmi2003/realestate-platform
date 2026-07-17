"""
MCP Agent Orchestrator.
Replaces the LangGraph state machine with a clean, linear flow:
classify intent -> route to tool -> execute -> generate response.
"""

import asyncio
import json
import logging
from typing import Any, Optional

from api_py.agent.models import (
    AgentState,
    ChatRequest,
    ChatResponse,
    ToolChoice,
    Message,
)
from api_py.agent.intent_classifier import IntentClassifier
from api_py.agent.response_generator import ResponseGenerator
from api_py.mcp.server import MCPServer
from api_py.services.session_memory import SessionMemoryService
from api_py.shared.text_utils import (
    format_property_summary,
    format_property_details,
    clean_query_for_text_search,
)
from api_py.shared.config import config

logger = logging.getLogger(__name__)


class AgentOrchestrator:
    """
    Main agent orchestrator.
    Coordinates intent classification, tool selection, tool execution,
    and response generation in a clean, linear flow.
    """

    def __init__(self, mcp_server: MCPServer):
        self.mcp = mcp_server
        self.intent_classifier = IntentClassifier()
        self.response_generator = ResponseGenerator()
        self.memory_service = SessionMemoryService()

    async def process(self, request: ChatRequest) -> ChatResponse:
        """
        Process a chat request through the full agent pipeline.

        Args:
            request: The incoming chat request from the frontend.

        Returns:
            ChatResponse with text, properties, and updated session state.
        """
        # 1. Build initial state
        state = self._build_state(request)

        # 2. Handle simple close/exit messages
        latest_query = request.messages[-1].content.lower().strip()
        if latest_query in ["close", "exit", "goodbye", "bye", "that's all", "thank you"]:
            return ChatResponse(
                text_response="You're welcome! Let me know if you need anything else.",
                properties=[],
                session_state={},
            )

        # 3. Fetch session memory
        await self._fetch_memory(state)

        # 4. Classify intent
        intent = await self.intent_classifier.classify(
            messages=state["messages"],
            properties_in_context=state.get("properties_in_context", []),
            focused_property_details=state.get("focused_property_details"),
        )
        state["intent"] = intent

        # 5. Route to tool based on intent
        tool_choice = await self._route_intent(intent, state)

        # 6. Execute tool if needed
        if tool_choice and tool_choice.tool_name != "respond_to_user":
            await self._execute_tool(tool_choice, state)

        # 7. Generate response
        context = self._build_response_context(state, tool_choice)
        response_text = await self.response_generator.generate(
            messages=state["messages"],
            context=context,
            intent=intent,
            session_memory=state.get("session_memory", []),
        )

        # 8. Store memory if meaningful
        await self._maybe_store_memory(state, response_text)

        # 9. Build response
        properties_for_ui = state.get("properties_for_ui") or []
        session_state = self._build_session_state(state)

        return ChatResponse(
            text_response=response_text,
            properties=properties_for_ui,
            session_state=session_state,
        )

    def _build_state(self, request: ChatRequest) -> AgentState:
        """Build agent state from the frontend request."""
        messages = []
        for msg in request.messages:
            content = msg.content
            # Enhance AI messages with property count context
            if msg.role == "assistant" and msg.properties:
                content += f"\n[Displayed {len(msg.properties)} properties to user]"
            messages.append({
                "role": msg.role,
                "content": content,
                "properties": msg.properties,
            })

        session_state = request.session_state or {}

        return AgentState(
            messages=messages,
            intent=None,
            search_criteria=session_state.get("search_criteria", {}),
            last_successful_search=session_state.get("last_successful_search"),
            page=session_state.get("page", 1),
            properties_in_context=session_state.get("properties_in_context", []),
            projects_in_context=session_state.get("projects_in_context", []),
            focused_property_id=session_state.get("focused_property_id"),
            focused_property_details=session_state.get("focused_property_details"),
            properties_for_ui=None,
            session_id=request.session_id,
            session_memory=[],
        )

    async def _fetch_memory(self, state: AgentState) -> None:
        """Fetch relevant session memory."""
        session_id = state.get("session_id")
        last_query = state["messages"][-1].get("content", "") if state["messages"] else ""

        if session_id and last_query:
            try:
                memories = await self.memory_service.search_memory(
                    session_id, last_query, k=3
                )
                state["session_memory"] = memories
            except Exception as e:
                logger.error(f"Memory fetch error: {e}")
                state["session_memory"] = []
        else:
            state["session_memory"] = []

    async def _route_intent(
        self, intent: str, state: AgentState
    ) -> Optional[ToolChoice]:
        """Route classified intent to the appropriate tool."""
        current_criteria = state.get("search_criteria", {})
        last_search = state.get("last_successful_search")
        current_page = state.get("page", 1)

        if intent == "META_COMMAND_RESET":
            state.update({
                "search_criteria": {},
                "last_successful_search": None,
                "page": 1,
                "properties_in_context": [],
                "projects_in_context": [],
                "focused_property_id": None,
                "focused_property_details": None,
                "properties_for_ui": None,
                "tool_output": "Okay, let's start fresh. What are you looking for today?",
            })
            return ToolChoice(
                tool_name="respond_to_user",
                tool_input=None,
            )

        if intent == "PROJECT_NAME_SEARCH":
            user_query = state["messages"][-1].get("content", "")
            cleaned_query = clean_query_for_text_search(user_query)
            if len(cleaned_query.split()) < 2 or cleaned_query == user_query.strip():
                cleaned_query = await self.response_generator.extract_project_name(
                    state["messages"], user_query
                )

            # Check context cache
            projects_in_context = state.get("projects_in_context", [])
            for proj in projects_in_context:
                name = proj.get("name", "").lower()
                if cleaned_query.lower() in name:
                    return ToolChoice(
                        tool_name="get_project_details_by_slug",
                        tool_input={"slug": proj["slug"]},
                    )

            state.update({
                "search_criteria": {},
                "last_successful_search": None,
                "page": 1,
            })
            return ToolChoice(
                tool_name="project_text_search",
                tool_input={"query": cleaned_query},
            )

        if intent == "SEMANTIC_SEARCH":
            user_query = state["messages"][-1].get("content", "")
            state.update({
                "search_criteria": {},
                "last_successful_search": None,
                "page": 1,
            })
            return ToolChoice(
                tool_name="semantic_property_search",
                tool_input={"query": user_query},
            )

        if intent in ["NEW_SEARCH", "REFINE_SEARCH", "CLARIFICATION_RESPONSE"]:
            merged_criteria = await self.response_generator.extract_search_criteria(
                state["messages"], current_criteria
            )
            if not merged_criteria.get("location"):
                state["search_criteria"] = merged_criteria
                state["tool_output"] = (
                    "I can certainly help with that. Could you please let me know "
                    "the city or area you're interested in?"
                )
                return ToolChoice(
                    tool_name="respond_to_user",
                    tool_input=None,
                )

            state.update({
                "search_criteria": merged_criteria,
                "last_successful_search": merged_criteria,
                "page": 1,
            })
            return ToolChoice(
                tool_name="structured_property_search",
                tool_input=merged_criteria,
            )

        if intent == "PAGINATION":
            if not last_search:
                state["tool_output"] = (
                    "I'm not sure what search you'd like to see more of. "
                    "Could you please start a new search?"
                )
                return ToolChoice(
                    tool_name="respond_to_user",
                    tool_input=None,
                )

            state["page"] = current_page + 1
            return ToolChoice(
                tool_name="structured_property_search",
                tool_input=last_search,
            )

        if intent == "REQUEST_DETAILS":
            property_id = await self.response_generator.match_property_id(
                user_message=state["messages"][-1].get("content", ""),
                properties_in_context=state.get("properties_in_context", []),
            )
            if property_id:
                state["focused_property_id"] = property_id
                return ToolChoice(
                    tool_name="get_listing_details",
                    tool_input={"listing_id": property_id},
                )
            state["tool_output"] = (
                "I'm sorry, I'm not sure which property you're referring to. "
                "Could you please be more specific?"
            )
            return ToolChoice(
                tool_name="respond_to_user",
                tool_input=None,
            )

        if intent == "FOLLOW_UP_QUESTION":
            focused_details = state.get("focused_property_details")
            if focused_details:
                details_summary = format_property_details(focused_details)
                state["tool_output"] = details_summary
                return ToolChoice(
                    tool_name="respond_to_user",
                    tool_input=None,
                )
            # No focused property - ask for clarification
            if state.get("properties_in_context"):
                state["tool_output"] = (
                    "I'm not sure which of those properties you're asking about. "
                    "Could you ask me to get details for one of them first? "
                    "For example, 'Tell me more about the first one'."
                )
            else:
                state["tool_output"] = (
                    "I'm sorry, I'm not sure which property you're referring to. "
                    "Could you start a new search or ask for details on a property?"
                )
            return ToolChoice(
                tool_name="respond_to_user",
                tool_input=None,
            )

        if intent == "GENERAL_QUERY":
            return ToolChoice(
                tool_name="knowledge_web_search",
                tool_input={"query": state["messages"][-1].get("content", "")},
            )

        # Fallback
        state["tool_output"] = (
            "I'm sorry, I'm not sure how to handle that. Could you rephrase?"
        )
        return ToolChoice(
            tool_name="respond_to_user",
            tool_input=None,
        )

    async def _execute_tool(
        self, tool_choice: ToolChoice, state: AgentState
    ) -> None:
        """Execute the selected tool and update state."""
        tool_name = tool_choice.tool_name
        tool_input = tool_choice.tool_input or {}

        # Add page parameter for structured search
        if tool_name == "structured_property_search":
            tool_input["page"] = state.get("page", 1)

        try:
            output = await self.mcp.execute_tool(tool_name, tool_input)
            logger.info(f"Tool {tool_name} executed successfully")

            # Always store raw tool output for response context
            state["tool_output"] = output

            # Parse and update state based on tool type
            if tool_name in [
                "structured_property_search",
                "full_text_property_search",
                "semantic_property_search",
                "project_text_search",
            ]:
                try:
                    parsed = json.loads(output)
                    if isinstance(parsed, list):
                        state["properties_in_context"] = parsed
                        state["properties_for_ui"] = parsed
                        if tool_name == "project_text_search":
                            state["projects_in_context"] = parsed
                except (json.JSONDecodeError, TypeError):
                    pass

            elif tool_name in ["get_listing_details", "get_project_details_by_slug"]:
                try:
                    parsed = json.loads(output)
                    if isinstance(parsed, dict):
                        state["focused_property_details"] = parsed
                except (json.JSONDecodeError, TypeError):
                    pass

        except Exception as e:
            logger.error(f"Tool execution error: {e}", exc_info=True)
            state["tool_output"] = f"Error: {e}"

    def _build_response_context(
        self, state: AgentState, tool_choice: Optional[ToolChoice]
    ) -> str:
        """Build the context string for response generation."""
        tool_output = state.get("tool_output")
        properties_for_ui = state.get("properties_for_ui") or []
        intent = state.get("intent")
        tool_name = tool_choice.tool_name if tool_choice else None

        # Handle respond_to_user (pre-filled context from routing)
        if tool_name == "respond_to_user" and tool_output:
            return tool_output

        # Handle search results
        if properties_for_ui:
            page_number = state.get("page", 1)
            return (
                f"Found {len(properties_for_ui)} results (Page {page_number}):\n"
                f"{format_property_summary(properties_for_ui)}"
            )

        # Handle property/project details
        focused_details = state.get("focused_property_details")
        if focused_details:
            return f"Here are the details for the requested item:\n{format_property_details(focused_details)}"

        # Handle knowledge web search (raw string output)
        if tool_name == "knowledge_web_search" and tool_output:
            return tool_output

        # Handle any other tool output
        if tool_output:
            return tool_output

        # Fallback
        return "I'm sorry, I'm not sure what to do next. Could you rephrase?"

    async def _maybe_store_memory(
        self, state: AgentState, response_text: str
    ) -> None:
        """Store the conversation exchange in session memory if meaningful."""
        session_id = state.get("session_id")
        query = state["messages"][-1].get("content", "") if state["messages"] else ""

        if not session_id:
            return

        if (
            len(query.split()) > config.MEANINGFUL_QUERY_WORDS
            or len(response_text.split()) > config.MEANINGFUL_ANSWER_WORDS
        ):
            text_to_store = f"User: {query}\nBot: {response_text}"
            try:
                asyncio.create_task(
                    self.memory_service.store_memory(session_id, text_to_store)
                )
            except Exception as e:
                logger.error(f"Memory store error: {e}")

    def _build_session_state(self, state: AgentState) -> dict:
        """Build the session state to return to the frontend."""
        return {
            "search_criteria": state.get("search_criteria"),
            "last_successful_search": state.get("last_successful_search"),
            "page": state.get("page"),
            "properties_in_context": state.get("properties_in_context", []),
            "projects_in_context": state.get("projects_in_context", []),
            "focused_property_id": state.get("focused_property_id"),
            "focused_property_details": state.get("focused_property_details"),
            "summary": state.get("summary", ""),
        }
