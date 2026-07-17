"""
LLM-based intent classifier.
Classifies user messages into intents using a configurable LLM provider.
"""

import json
import logging
from typing import Any, Optional

from api_py.shared.config import config
from api_py.shared.llm_client import llm_chat
from api_py.shared.text_utils import format_property_summary

logger = logging.getLogger(__name__)


class IntentClassifier:
    """
    Classifies user intent using LLM.
    Supports Groq and OpenAI providers via config.
    """

    async def classify(
        self,
        messages: list[dict[str, Any]],
        properties_in_context: list[dict[str, Any]],
        focused_property_details: Optional[dict[str, Any]],
    ) -> str:
        """
        Classify the user's intent from the conversation.

        Args:
            messages: Conversation history (list of dicts with 'role' and 'content').
            properties_in_context: Properties currently visible to the user.
            focused_property_details: Details of the property the user is viewing.

        Returns:
            Classified intent string (e.g., "NEW_SEARCH", "REQUEST_DETAILS").
        """
        from api_py.prompts.intent_classification import INTENT_CLASSIFICATION_SYSTEM

        properties_on_screen = format_property_summary(properties_in_context)

        if focused_property_details:
            title = focused_property_details.get("title", "Unknown")
            pid = focused_property_details.get("id", "Unknown")
            active_property_str = f"Title: {title}, ID: {pid}"
        else:
            active_property_str = "None"

        recent = messages[-config.INTENT_HISTORY_LIMIT:]
        history_str = "\n".join(
            [f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in recent]
        )
        last_message = messages[-1].get("content", "") if messages else ""

        user_prompt = f"""[Active Property]:
{active_property_str}

[Properties on Screen]:
{properties_on_screen}

Conversation History:
{history_str}

User's final message: '{last_message}'

Classification:"""

        try:
            content = await llm_chat(
                system_prompt=INTENT_CLASSIFICATION_SYSTEM,
                user_prompt=user_prompt,
                response_format={"type": "json_object"},
            )
            result = json.loads(content)
            intent = result.get("intent", "GENERAL_QUERY")
            logger.info(f"Intent classified as: {intent}")
            return intent

        except Exception as e:
            logger.error(f"Intent classification error: {e}")
            return "GENERAL_QUERY"
