"""
LLM-based response generator.
Synthesizes final user-facing responses using a configurable LLM provider.
"""

import json
import logging
from typing import Any, Optional

from api_py.shared.config import config
from api_py.shared.llm_client import llm_chat

logger = logging.getLogger(__name__)


class ResponseGenerator:
    """
    Generates final responses using LLM.
    Supports Groq and OpenAI providers via config.
    """

    async def generate(
        self,
        messages: list[dict[str, Any]],
        context: str,
        intent: Optional[str],
        session_memory: list[str],
    ) -> str:
        """
        Generate the final user-facing response.

        Args:
            messages: Conversation history.
            context: The formatted context (tool output, property details, etc.).
            intent: The classified user intent.
            session_memory: Relevant past exchanges from session memory.

        Returns:
            The generated response text.
        """
        from api_py.prompts.response_synthesis import RESPONSE_SYNTHESIS_SYSTEM

        recent = messages[-config.RESPONSE_HISTORY_LIMIT:]
        history_str = "\n".join(
            [f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in recent]
        )

        # Conditionally inject session memory
        if intent == "FOLLOW_UP_QUESTION":
            session_memory_str = ""
        elif session_memory:
            session_memory_str = "\n".join(session_memory)
        else:
            session_memory_str = ""

        user_prompt = f"""[Relevant Past Exchanges]:
{session_memory_str or "None"}

[Recent Conversation]:
{history_str}

[Latest Information to Formulate Your Answer]:
{context}

[User's Intent]:
{intent or "None"}
"""

        try:
            content = await llm_chat(
                system_prompt=RESPONSE_SYNTHESIS_SYSTEM,
                user_prompt=user_prompt,
            )
            logger.info(f"Response generated ({len(content)} chars)")
            return content.strip()

        except Exception as e:
            logger.error(f"Response generation error: {e}")
            return "I'm sorry, I encountered an error generating a response. Could you try again?"

    async def extract_search_criteria(
        self,
        messages: list[dict[str, Any]],
        current_criteria: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Extract and merge search criteria from conversation context.

        Args:
            messages: Conversation history.
            current_criteria: Existing search criteria to merge with.

        Returns:
            Updated search criteria dict.
        """
        from api_py.prompts.search_criteria import SEARCH_CRITERIA_SYSTEM

        recent = messages[-config.INTENT_HISTORY_LIMIT:]
        history_str = "\n".join(
            [f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in recent]
        )
        last_message = messages[-1].get("content", "") if messages else ""

        user_prompt = f"""Conversation History (Bot's last message is most important):
{history_str}

User's final message: '{last_message}'

Extracted Parameters:"""

        try:
            content = await llm_chat(
                system_prompt=SEARCH_CRITERIA_SYSTEM,
                user_prompt=user_prompt,
                response_format={"type": "json_object"},
            )
            new_criteria = json.loads(content)

            merged = current_criteria.copy()
            for key, value in new_criteria.items():
                if value is not None:
                    merged[key] = value

            logger.info(f"Extracted criteria: {new_criteria}, Merged: {merged}")
            return merged

        except Exception as e:
            logger.error(f"Search criteria extraction error: {e}")
            return current_criteria

    async def match_property_id(
        self,
        user_message: str,
        properties_in_context: list[dict[str, Any]],
    ) -> Optional[str]:
        """
        Match a user's reference to a property ID from the visible list.

        Args:
            user_message: The user's message referencing a property.
            properties_in_context: Properties visible to the user.

        Returns:
            The matched property ID, or None if no match found.
        """
        from api_py.shared.text_utils import format_property_summary
        from api_py.prompts.property_matching import PROPERTY_MATCHING_SYSTEM

        if not properties_in_context:
            return None

        property_summary = format_property_summary(properties_in_context)

        user_prompt = f"""Property List:
{property_summary}

User's Request: '{user_message}'

Matched ID:"""

        try:
            content = await llm_chat(
                system_prompt=PROPERTY_MATCHING_SYSTEM,
                user_prompt=user_prompt,
                response_format={"type": "json_object"},
            )
            result = json.loads(content)
            property_id = result.get("property_id")

            if property_id:
                logger.info(f"LLM matched to property ID: {property_id}")
            else:
                logger.warning("LLM could not match to any property.")

            return property_id

        except Exception as e:
            logger.error(f"Property matching error: {e}")
            return None

    async def extract_project_name(
        self,
        messages: list[dict[str, Any]],
        user_query: str,
    ) -> str:
        """
        Extract a clean project/property name from user query.

        Args:
            messages: Conversation history.
            user_query: The raw user query.

        Returns:
            The cleaned search phrase.
        """
        from api_py.prompts.project_extraction import PROJECT_EXTRACTION_SYSTEM

        recent = messages[-config.INTENT_HISTORY_LIMIT:]
        history_str = "\n".join(
            [f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in recent]
        )

        user_prompt = f"""Conversation History:
{history_str}

User's final message: '{user_query}'

Extracted Search Phrase:"""

        try:
            content = await llm_chat(
                system_prompt=PROJECT_EXTRACTION_SYSTEM,
                user_prompt=user_prompt,
            )
            return content.strip(" \n.:;!?\"'")

        except Exception as e:
            logger.error(f"Project name extraction error: {e}")
            return user_query.strip()
