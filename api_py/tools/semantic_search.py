"""
Semantic Property Search tool.
Searches properties using natural language descriptions via vector similarity.
"""

from typing import Any

from api_py.tools.base import MCPTool
from api_py.mcp.schemas import ToolParameter, ToolExample
from api_py.services.property_search import PropertySearchService


class SemanticPropertySearchTool(MCPTool):
    name = "semantic_property_search"
    version = "1.0.0"
    category = "property_search"
    output_description = "A JSON array of property objects matching the semantic description."
    tags = ["search", "property", "semantic", "conceptual", "lifestyle"]

    description = (
        "Search for properties using natural language descriptions. "
        "Use this for vague, conceptual, or lifestyle-based queries where the user "
        "describes what they want rather than providing specific filters."
    )

    when_to_use = (
        "For conceptual or lifestyle queries: 'quiet family home with a garden', "
        "'modern design near metro', 'properties with a pool and gym', "
        "'something affordable but spacious'."
    )

    when_not_to_use = (
        "For specific filtered searches ('2bhk in Gurgaon under 1 crore'), "
        "by-name searches, or general questions about real estate."
    )

    input_parameters = [
        ToolParameter(
            name="query",
            type="string",
            description="A descriptive or conceptual query. Example: 'a quiet family home with a garden'.",
            required=True,
        ),
    ]

    examples = [
        ToolExample(
            description="Find a quiet family home with garden",
            input={"query": "quiet family home with a garden"},
        ),
        ToolExample(
            description="Find modern properties near metro",
            input={"query": "modern design near metro station"},
        ),
    ]

    def __init__(self):
        self._service = PropertySearchService()

    async def execute(self, params: dict[str, Any]) -> Any:
        return await self._service.semantic_search(params["query"])
