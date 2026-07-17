"""
Tool discovery API endpoint.
Exposes MCP tool schemas via HTTP for discovery, debugging, and documentation.
"""

import logging
from fastapi import APIRouter

from api_py.mcp.server import MCPServer

logger = logging.getLogger(__name__)

router = APIRouter()

_mcp_server: MCPServer | None = None


def set_mcp_server(server: MCPServer) -> None:
    """Set the MCP server instance (called during app startup)."""
    global _mcp_server
    _mcp_server = server


@router.get("/api/mcp/tools")
async def list_tools():
    """
    List all registered MCP tool schemas.
    Returns tool names, descriptions, parameters, examples, and metadata.
    """
    if _mcp_server is None:
        return {"tools": [], "total": 0, "categories": []}

    return _mcp_server.to_tool_list_json()


@router.get("/api/mcp/tools/{tool_name}")
async def get_tool_schema(tool_name: str):
    """Get the schema for a specific tool."""
    if _mcp_server is None:
        return {"error": "MCP server not initialized"}

    try:
        schema = _mcp_server.get_tool_schema(tool_name)
        return schema.to_dict()
    except Exception as e:
        return {"error": str(e)}
