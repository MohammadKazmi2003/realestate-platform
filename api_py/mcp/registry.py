"""
MCP Tool Registry.
Central registry for discovering, listing, and managing MCP tools.
"""

import logging
from typing import Optional

from api_py.mcp.schemas import MCPToolSchema
from api_py.mcp.errors import ToolNotFoundError

logger = logging.getLogger(__name__)


class ToolRegistry:
    """
    Central registry for MCP tools.
    Supports hierarchical discovery by category and tag-based filtering.
    """

    def __init__(self):
        self._tools: dict[str, MCPToolSchema] = {}
        self._categories: dict[str, list[str]] = {}

    def register(self, schema: MCPToolSchema) -> None:
        """Register a tool schema."""
        self._tools[schema.name] = schema

        category = schema.metadata.category
        if category not in self._categories:
            self._categories[category] = []
        if schema.name not in self._categories[category]:
            self._categories[category].append(schema.name)

        logger.info(f"Registered MCP tool: {schema.name} (v{schema.metadata.version})")

    def get(self, tool_name: str) -> MCPToolSchema:
        """Get a tool schema by name."""
        if tool_name not in self._tools:
            raise ToolNotFoundError(tool_name)
        return self._tools[tool_name]

    def list_tools(self) -> list[MCPToolSchema]:
        """List all registered tool schemas."""
        return list(self._tools.values())

    def list_by_category(self, category: str) -> list[MCPToolSchema]:
        """List tools in a specific category."""
        tool_names = self._categories.get(category, [])
        return [self._tools[name] for name in tool_names if name in self._tools]

    def list_categories(self) -> list[str]:
        """List all registered categories."""
        return list(self._categories.keys())

    def search_by_tags(self, tags: list[str]) -> list[MCPToolSchema]:
        """Find tools that match any of the given tags."""
        tag_set = set(tags)
        return [
            schema
            for schema in self._tools.values()
            if tag_set.intersection(schema.metadata.tags)
        ]

    def get_model_tools(self) -> list[dict]:
        """Get all tools in LLM function-calling format."""
        return [schema.to_model_tool() for schema in self._tools.values()]

    def get_tool_names(self) -> list[str]:
        """Get all registered tool names."""
        return list(self._tools.keys())

    def has_tool(self, tool_name: str) -> bool:
        """Check if a tool is registered."""
        return tool_name in self._tools

    def __len__(self) -> int:
        return len(self._tools)

    def __contains__(self, tool_name: str) -> bool:
        return self.has_tool(tool_name)
