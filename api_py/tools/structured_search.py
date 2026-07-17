"""
Structured Property Search tool.
Searches properties using filters like location, type, price, bedrooms.
"""

from typing import Any

from api_py.tools.base import MCPTool
from api_py.mcp.schemas import ToolParameter, ToolExample
from api_py.services.property_search import PropertySearchService, StructuredSearchParams


class StructuredPropertySearchTool(MCPTool):
    name = "structured_property_search"
    version = "1.0.0"
    category = "property_search"
    output_description = "A JSON array of property objects, each with id, title, price, location, property_type, and bedrooms."
    tags = ["search", "property", "filtered", "structured"]

    description = (
        "Search for properties using structured filters like location, type, price range, and bedrooms. "
        "Use this tool for specific, criteria-based searches when the user provides concrete requirements. "
        "This is the primary tool for new searches and for refining existing searches."
    )

    when_to_use = (
        "When the user provides specific search criteria such as location, property type, "
        "price range, or number of bedrooms. Examples: 'find 2 bedroom apartments in Gurgaon under 50 lakhs', "
        "'show me villas in Dubai Marina', 'properties between 1-2 crore in Noida'."
    )

    when_not_to_use = (
        "For vague or conceptual searches ('something modern', 'quiet family home'), "
        "for finding a property by its name ('Azure Heights'), or for general questions about real estate."
    )

    input_parameters = [
        ToolParameter(
            name="location",
            type="string",
            description="The city, neighborhood, or area to search in. Example: 'Gurgaon', 'Dubai Marina'.",
            required=False,
        ),
        ToolParameter(
            name="property_type",
            type="string",
            description="The type of property.",
            required=False,
            enum=["apartment", "villa", "plot", "commercial", "land"],
        ),
        ToolParameter(
            name="min_price",
            type="number",
            description="Minimum budget in Indian Rupees (INR). Example: 5000000 for 50 lakhs.",
            required=False,
        ),
        ToolParameter(
            name="max_price",
            type="number",
            description="Maximum budget in Indian Rupees (INR). Example: 10000000 for 1 crore.",
            required=False,
        ),
        ToolParameter(
            name="bedrooms",
            type="integer",
            description="Number of bedrooms required. Example: 2 for a 2BHK.",
            required=False,
        ),
        ToolParameter(
            name="page",
            type="integer",
            description="Page number for pagination. Use 1 for a new search.",
            required=False,
            default=1,
        ),
    ]

    examples = [
        ToolExample(
            description="Find 2BHK apartments in Gurgaon under 1 crore",
            input={
                "location": "Gurgaon",
                "property_type": "apartment",
                "bedrooms": 2,
                "max_price": 10000000,
            },
        ),
        ToolExample(
            description="Search for villas in Dubai Marina",
            input={"location": "Dubai Marina", "property_type": "villa"},
        ),
        ToolExample(
            description="Get page 2 of previous search",
            input={"location": "Gurgaon", "page": 2},
        ),
    ]

    def __init__(self):
        self._service = PropertySearchService()

    async def execute(self, params: dict[str, Any]) -> Any:
        search_params = StructuredSearchParams(
            location=params.get("location"),
            property_type=params.get("property_type"),
            min_price=params.get("min_price"),
            max_price=params.get("max_price"),
            bedrooms=params.get("bedrooms"),
            page=params.get("page", 1),
        )
        return await self._service.structured_search(search_params)
