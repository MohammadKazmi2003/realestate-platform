"""MCP (Model Context Protocol) server layer."""

from api_py.mcp.server import MCPServer
from api_py.mcp.registry import ToolRegistry
from api_py.mcp.dispatcher import MCPToolDispatcher
from api_py.mcp.schemas import MCPToolSchema, ToolMetadata, ToolExample
from api_py.mcp.errors import MCPError, ToolNotFoundError, ToolValidationError

__all__ = [
    "MCPServer",
    "ToolRegistry",
    "MCPToolDispatcher",
    "MCPToolSchema",
    "ToolMetadata",
    "ToolExample",
    "MCPError",
    "ToolNotFoundError",
    "ToolValidationError",
]
