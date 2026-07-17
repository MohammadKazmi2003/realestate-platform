"""
Chat API endpoint.
Bridges the frontend HTTP contract to the MCP agent.
Maintains backward compatibility with the existing POST /api/chat contract.
"""

import logging
from fastapi import APIRouter, HTTPException

from api_py.agent.models import ChatRequest, ChatResponse
from api_py.agent.orchestrator import AgentOrchestrator
from api_py.shared.rate_limit import RateLimiter
from api_py.shared.config import config

logger = logging.getLogger(__name__)

router = APIRouter()

_rate_limiter = RateLimiter(
    max_requests=config.RATE_LIMIT_MAX_REQUESTS,
    window_seconds=config.RATE_LIMIT_WINDOW_SECONDS,
)

# Will be set by main.py during startup
_orchestrator: AgentOrchestrator | None = None


def set_orchestrator(orchestrator: AgentOrchestrator) -> None:
    """Set the orchestrator instance (called during app startup)."""
    global _orchestrator
    _orchestrator = orchestrator


@router.post("/api/chat_langchain")
@router.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    """
    Main chat endpoint for the conversational agent.
    Accepts the same request/response contract as the legacy /api/chat_langchain.
    """
    if _orchestrator is None:
        raise HTTPException(status_code=503, detail="Agent not initialized.")

    if not _rate_limiter.is_allowed(request.session_id):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please wait a moment.",
        )

    try:
        response: ChatResponse = await _orchestrator.process(request)
        return {
            "text_response": response.text_response,
            "properties": response.properties,
            "session_state": response.session_state,
        }
    except Exception as e:
        logger.error(f"Chat endpoint error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="An internal server error occurred. Please try again.",
        )
