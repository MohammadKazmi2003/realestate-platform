"""
Project Text Search tool.
Searches for real estate projects by name.
"""

from typing import Any

from api_py.tools.base import MCPTool
from api_py.mcp.schemas import ToolParameter, ToolExample
from api_py.services.property_search import PropertySearchService


class ProjectSearchTool(MCPTool):
    name = "project_text_search"
    version = "1.0.0"
    category = "property_search"
    output_description = "A JSON array of project objects matching the search query."
    tags = ["search", "project", "text", "name", "development"]

    description = (
        "Search for real estate projects or developments by name. "
        "Use this ONLY when the user is looking for a specific project/development. "
        "This searches the dedicated projects index and returns project-level results."
    )

    when_to_use = (
        "When the user searches for a project by name: 'tell me about Sobha Hartland', "
        "'show me Azizi Venice', 'do you have Sobha One?'."
    )

    when_not_to_use = (
        "For individual property listings (use full_text_property_search instead), "
        "general filtered searches, or conceptual searches."
    )

    input_parameters = [
        ToolParameter(
            name="query",
            type="string",
            description="The specific name of a project to search for. Example: 'Sobha Hartland', 'Azizi Venice'.",
            required=True,
        ),
    ]

    examples = [
        ToolExample(
            description="Search for Sobha Hartland project",
            input={"query": "Sobha Hartland"},
        ),
        ToolExample(
            description="Search for Azizi Venice project",
            input={"query": "Azizi Venice"},
        ),
    ]

    def __init__(self):
        self._service = PropertySearchService()

    async def execute(self, params: dict[str, Any]) -> Any:
        return await self._service.search_projects(params["query"])
