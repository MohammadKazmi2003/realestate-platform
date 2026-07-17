"""
Knowledge Web Search tool.
Handles general real estate Q&A via web search.
"""

from typing import Any

from api_py.tools.base import MCPTool
from api_py.mcp.schemas import ToolParameter, ToolExample
from api_py.services.knowledge import KnowledgeService


class KnowledgeSearchTool(MCPTool):
    name = "knowledge_web_search"
    version = "1.0.0"
    category = "knowledge"
    output_description = "A string containing the search results about the topic."
    tags = ["knowledge", "web", "general", "q&a"]

    description = (
        "Search the web for general real estate knowledge and information. "
        "Use this for questions that do NOT involve finding specific property listings."
    )

    when_to_use = (
        "For general real estate questions: 'what is stamp duty in Gurgaon?', "
        "'how do I get a home loan in India?', 'best schools in South Delhi', "
        "'what are the costs of buying property in Dubai?'."
    )

    when_not_to_use = (
        "When the user wants to find specific property listings (use search tools instead), "
        "or when asking about a specific property already shown."
    )

    input_parameters = [
        ToolParameter(
            name="query",
            type="string",
            description="A general real estate question. Example: 'what is stamp duty in Gurgaon?'.",
            required=True,
        ),
    ]

    examples = [
        ToolExample(
            description="Ask about stamp duty in Gurgaon",
            input={"query": "what is stamp duty in Gurgaon?"},
        ),
        ToolExample(
            description="Ask about home loans in India",
            input={"query": "how do I get a home loan in India?"},
        ),
    ]

    def __init__(self):
        self._service = KnowledgeService()

    async def execute(self, params: dict[str, Any]) -> Any:
        return await self._service.web_search(params["query"])
