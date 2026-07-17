"""
Direct tool invocation endpoint.
Allows invoking MCP tools directly for testing and debugging.
"""

import json
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Optional

from api_py.mcp.server import MCPServer

logger = logging.getLogger(__name__)

router = APIRouter()

_mcp_server: MCPServer | None = None


def set_mcp_server(server: MCPServer) -> None:
    """Set the MCP server instance (called during app startup)."""
    global _mcp_server
    _mcp_server = server


class ToolInvocationRequest(BaseModel):
    tool_name: str
    params: dict[str, Any] = {}
    timeout: float = 30.0


@router.post("/api/mcp/invoke")
async def invoke_tool(request: ToolInvocationRequest):
    """
    Invoke an MCP tool directly.
    Useful for testing tool execution without the full agent pipeline.
    """
    if _mcp_server is None:
        raise HTTPException(status_code=503, detail="MCP server not initialized.")

    try:
        result = await _mcp_server.execute_tool(
            tool_name=request.tool_name,
            params=request.params,
            timeout=request.timeout,
        )
        # Try to parse as JSON for structured response
        try:
            parsed = json.loads(result)
            return {"tool": request.tool_name, "result": parsed}
        except (json.JSONDecodeError, TypeError):
            return {"tool": request.tool_name, "result": result}
    except Exception as e:
        logger.error(f"Tool invocation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
