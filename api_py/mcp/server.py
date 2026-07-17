"""
MCP Server.
Ties together the tool registry, dispatcher, and provides the main API
for tool discovery, execution, and schema management.
"""

import logging
from typing import Any, Optional

from api_py.mcp.registry import ToolRegistry
from api_py.mcp.dispatcher import MCPToolDispatcher
from api_py.mcp.schemas import MCPToolSchema
from api_py.mcp.errors import MCPError

logger = logging.getLogger(__name__)


class MCPServer:
    """
    Main MCP server entry point.
    Provides a unified API for tool registration, discovery, and execution.
    """

    def __init__(self):
        self.registry = ToolRegistry()
        self.dispatcher = MCPToolDispatcher()

    def register_tool(
        self, schema: MCPToolSchema, handler: Any
    ) -> None:
        """
        Register a tool with both the registry and dispatcher.

        Args:
            schema: The tool's schema for discovery and validation.
            handler: The tool handler (MCPTool instance or callable).
        """
        self.registry.register(schema)
        self.dispatcher.register_handler(schema.name, handler)
        logger.info(f"MCP tool registered: {schema.name}")

    def get_tool_schema(self, tool_name: str) -> MCPToolSchema:
        """Get a tool's schema by name."""
        return self.registry.get(tool_name)

    def list_tools(self) -> list[MCPToolSchema]:
        """List all registered tool schemas."""
        return self.registry.list_tools()

    def list_tools_by_category(self, category: str) -> list[MCPToolSchema]:
        """List tools in a specific category."""
        return self.registry.list_by_category(category)

    def get_model_tools(self) -> list[dict]:
        """Get all tools formatted for LLM function calling."""
        return self.registry.get_model_tools()

    async def execute_tool(
        self,
        tool_name: str,
        params: dict[str, Any],
        timeout: float = 30.0,
    ) -> str:
        """
        Execute a tool by name with the given parameters.

        Args:
            tool_name: Name of the tool to execute.
            params: Input parameters.
            timeout: Maximum execution time.

        Returns:
            JSON string of the tool result.
        """
        schema = self.registry.get(tool_name)
        return await self.dispatcher.execute(
            tool_name=tool_name,
            params=params,
            schema=schema,
            timeout=timeout,
        )

    def to_tool_list_json(self) -> dict:
        """
        Export all tool schemas as a JSON-serializable dict.
        Used by the GET /api/mcp/tools endpoint.
        """
        tools = self.registry.list_tools()
        categories = self.registry.list_categories()
        return {
            "tools": [t.to_dict() for t in tools],
            "total": len(tools),
            "categories": categories,
        }

    def to_model_tools_json(self) -> list[dict]:
        """
        Export all tools in LLM function-calling format.
        Used by the agent for tool selection.
        """
        return self.registry.get_model_tools()
