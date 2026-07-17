"""
Full-text Property Search tool.
Searches properties by name using full-text matching.
"""

from typing import Any

from api_py.tools.base import MCPTool
from api_py.mcp.schemas import ToolParameter, ToolExample
from api_py.services.property_search import PropertySearchService


class TextPropertySearchTool(MCPTool):
    name = "full_text_property_search"
    version = "1.0.0"
    category = "property_search"
    output_description = "A JSON array of property objects matching the search query."
    tags = ["search", "property", "text", "name"]

    description = (
        "Search for a property or project by its specific name using full-text matching. "
        "Use this ONLY when the user mentions a specific property or project name."
    )

    when_to_use = (
        "When the user searches by name: 'tell me about Azure Heights', "
        "'do you have anything in DLF Crest?', 'show me Sobha Hartland'."
    )

    when_not_to_use = (
        "For general filtered searches ('apartments in Gurgaon'), conceptual searches, "
        "or when the user provides criteria rather than a name."
    )

    input_parameters = [
        ToolParameter(
            name="query",
            type="string",
            description="The specific name of a property or project. Example: 'Azure Heights', 'DLF Crest'.",
            required=True,
        ),
    ]

    examples = [
        ToolExample(
            description="Search for Azure Heights property",
            input={"query": "Azure Heights"},
        ),
        ToolExample(
            description="Search for DLF Crest",
            input={"query": "DLF Crest"},
        ),
    ]

    def __init__(self):
        self._service = PropertySearchService()

    async def execute(self, params: dict[str, Any]) -> Any:
        return await self._service.text_search(params["query"])
