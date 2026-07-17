"""
MCP Agent - FastAPI Application Entry Point.
Initializes the MCP server, registers all tools, and starts the HTTP server.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api_py.shared.config import config
from api_py.mcp.server import MCPServer
from api_py.agent.orchestrator import AgentOrchestrator

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def _create_mcp_server() -> MCPServer:
    """Create and configure the MCP server with all tools."""
    server = MCPServer()

    # Import and register all tools
    from api_py.tools.structured_search import StructuredPropertySearchTool
    from api_py.tools.text_search import TextPropertySearchTool
    from api_py.tools.semantic_search import SemanticPropertySearchTool
    from api_py.tools.listing_details import ListingDetailsTool
    from api_py.tools.project_search import ProjectSearchTool
    from api_py.tools.project_details import ProjectDetailsTool
    from api_py.tools.knowledge_search import KnowledgeSearchTool

    tools = [
        StructuredPropertySearchTool(),
        TextPropertySearchTool(),
        SemanticPropertySearchTool(),
        ListingDetailsTool(),
        ProjectSearchTool(),
        ProjectDetailsTool(),
        KnowledgeSearchTool(),
    ]

    for tool in tools:
        schema = tool.get_schema()
        server.register_tool(schema, tool)

    logger.info(f"MCP server initialized with {len(tools)} tools")
    return server


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown events."""
    # --- Startup ---
    logger.info("Starting MCP Agent...")

    # Create MCP server
    mcp_server = _create_mcp_server()

    # Create orchestrator
    orchestrator = AgentOrchestrator(mcp_server)

    # Wire up the API endpoints
    from api_py.api.chat import set_orchestrator
    from api_py.api.tools_api import set_mcp_server as set_tools_mcp
    from api_py.api.invoke import set_mcp_server as set_invoke_mcp

    set_orchestrator(orchestrator)
    set_tools_mcp(mcp_server)
    set_invoke_mcp(mcp_server)

    logger.info("MCP Agent started successfully.")
    logger.info(f"LLM Provider: {config.LLM_PROVIDER.value}")
    logger.info(f"LLM Model: {config.LLM_MODEL}")
    logger.info(f"Tools registered: {mcp_server.registry.get_tool_names()}")

    yield

    # --- Shutdown ---
    logger.info("Shutting down MCP Agent...")


# --- FastAPI App ---
app = FastAPI(
    title="MCP Real Estate Agent",
    description="Model Context Protocol agent for real estate search and assistance.",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Register Routes ---
from api_py.api.chat import router as chat_router
from api_py.api.tools_api import router as tools_router
from api_py.api.invoke import router as invoke_router
from api_py.api.health import router as health_router
from api_py.api.search import router as search_router

app.include_router(chat_router)
app.include_router(tools_router)
app.include_router(invoke_router)
app.include_router(health_router)
app.include_router(search_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api_py.main:app",
        host=config.HOST,
        port=config.PORT,
        reload=True,
    )
