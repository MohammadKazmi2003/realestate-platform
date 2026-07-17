"""
Health check endpoint.
Returns status of the MCP server and its dependencies.
"""

import logging
from fastapi import APIRouter

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/health")
async def health_check():
    """
    Health check endpoint.
    Returns the status of the MCP server and its dependencies.
    """
    status = {
        "status": "healthy",
        "service": "mcp-agent",
        "checks": {},
    }

    # Check Supabase
    try:
        from api_py.data.supabase_client import get_supabase_client
        client = get_supabase_client()
        status["checks"]["supabase"] = "connected"
    except Exception as e:
        status["checks"]["supabase"] = f"error: {e}"
        status["status"] = "degraded"

    # Check LLM provider
    try:
        from api_py.shared.config import config
        if config.LLM_PROVIDER.value == "groq" and config.GROQ_API_KEY:
            status["checks"]["llm"] = f"configured (groq/{config.LLM_MODEL})"
        elif config.LLM_PROVIDER.value == "openai" and config.OPENAI_API_KEY:
            status["checks"]["llm"] = f"configured (openai/{config.LLM_MODEL})"
        else:
            status["checks"]["llm"] = "not configured"
            status["status"] = "degraded"
    except Exception as e:
        status["checks"]["llm"] = f"error: {e}"
        status["status"] = "degraded"

    # Check MCP server
    try:
        from api_py.api.chat import _orchestrator
        if _orchestrator is not None:
            tool_count = len(_orchestrator.mcp.list_tools())
            status["checks"]["mcp_server"] = f"initialized ({tool_count} tools)"
        else:
            status["checks"]["mcp_server"] = "not initialized"
            status["status"] = "degraded"
    except Exception as e:
        status["checks"]["mcp_server"] = f"error: {e}"
        status["status"] = "degraded"

    return status
