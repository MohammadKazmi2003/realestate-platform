"""Prompt templates for the MCP agent."""

from api_py.prompts.intent_classification import INTENT_CLASSIFICATION_SYSTEM
from api_py.prompts.search_criteria import SEARCH_CRITERIA_SYSTEM
from api_py.prompts.property_matching import PROPERTY_MATCHING_SYSTEM
from api_py.prompts.project_extraction import PROJECT_EXTRACTION_SYSTEM
from api_py.prompts.response_synthesis import RESPONSE_SYNTHESIS_SYSTEM

__all__ = [
    "INTENT_CLASSIFICATION_SYSTEM",
    "SEARCH_CRITERIA_SYSTEM",
    "PROPERTY_MATCHING_SYSTEM",
    "PROJECT_EXTRACTION_SYSTEM",
    "RESPONSE_SYNTHESIS_SYSTEM",
]
