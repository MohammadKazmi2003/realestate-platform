"""
Listing Details tool.
Retrieves full details for a single property by UUID.
"""

from typing import Any

from api_py.tools.base import MCPTool
from api_py.mcp.schemas import ToolParameter, ToolExample
from api_py.services.property_details import PropertyDetailsService


class ListingDetailsTool(MCPTool):
    name = "get_listing_details"
    version = "1.0.0"
    category = "property_details"
    output_description = "A JSON object with full property details including title, description, price, location, amenities, and media."
    tags = ["details", "property", "listing"]

    description = (
        "Get all detailed information about a single, specific property. "
        "You MUST have the listing_id from a previous search result to use this tool."
    )

    when_to_use = (
        "When the user asks for details about a property they have already seen in search results. "
        "Examples: 'tell me about the first one', 'show me details for Azure Heights', "
        "'what are the amenities of property ID xyz'."
    )

    when_not_to_use = (
        "When the user has not seen any search results yet, or when searching for new properties. "
        "The listing_id must come from a previous search result."
    )

    input_parameters = [
        ToolParameter(
            name="listing_id",
            type="string",
            description="The UUID of the property to get details for. Must be from a previous search result.",
            required=True,
        ),
    ]

    examples = [
        ToolExample(
            description="Get details for a property by UUID",
            input={"listing_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"},
        ),
    ]

    def __init__(self):
        self._service = PropertyDetailsService()

    async def execute(self, params: dict[str, Any]) -> Any:
        return await self._service.get_listing_details(params["listing_id"])
