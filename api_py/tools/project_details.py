"""
Project Details tool.
Retrieves full project details by URL slug.
"""

from typing import Any

from api_py.tools.base import MCPTool
from api_py.mcp.schemas import ToolParameter, ToolExample
from api_py.services.property_details import PropertyDetailsService


class ProjectDetailsTool(MCPTool):
    name = "get_project_details_by_slug"
    version = "1.0.0"
    category = "property_details"
    output_description = "A JSON object with full project details including developer, amenities, FAQs, unit configurations, and media."
    tags = ["details", "project", "slug"]

    description = (
        "Get all detailed information about a single project using its URL slug. "
        "You MUST have the slug from a previous project search result to use this tool."
    )

    when_to_use = (
        "When the user asks for details about a project they have already seen in search results. "
        "Examples: 'tell me more about Sobha Hartland', 'show me project details for Azizi Venice'."
    )

    when_not_to_use = (
        "When the user has not seen any project search results yet, "
        "or when searching for new projects. The slug must come from a previous search result."
    )

    input_parameters = [
        ToolParameter(
            name="slug",
            type="string",
            description="The URL slug of the project. Must be from a previous project search result.",
            required=True,
        ),
    ]

    examples = [
        ToolExample(
            description="Get details for a project by slug",
            input={"slug": "sobha-hartland"},
        ),
    ]

    def __init__(self):
        self._service = PropertyDetailsService()

    async def execute(self, params: dict[str, Any]) -> Any:
        return await self._service.get_project_details(params["slug"])
