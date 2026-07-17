"""
MCP Tool base class.
All MCP tools extend this class to provide self-describing schemas
and consistent execution interfaces.
"""

import json
import logging
from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel

from api_py.mcp.schemas import MCPToolSchema, ToolMetadata, ToolParameter, ToolExample

logger = logging.getLogger(__name__)


class MCPTool(ABC):
    """
    Base class for all MCP tools.
    Subclasses must define class-level attributes and implement execute().
    """

    name: str = ""
    description: str = ""
    version: str = "1.0.0"
    category: str = ""
    when_to_use: str = ""
    when_not_to_use: str = ""
    output_description: str = ""
    tags: list[str] = []

    # Subclasses define these
    input_parameters: list[ToolParameter] = []
    examples: list[ToolExample] = []

    @abstractmethod
    async def execute(self, params: dict[str, Any]) -> Any:
        """
        Execute the tool with the given parameters.

        Args:
            params: Dictionary of input parameters.

        Returns:
            Tool result (will be serialized to JSON by dispatcher).
        """
        ...

    def get_schema(self) -> MCPToolSchema:
        """Build and return the full MCPToolSchema for this tool."""
        metadata = ToolMetadata(
            category=self.category,
            when_to_use=self.when_to_use,
            when_not_to_use=self.when_not_to_use,
            version=self.version,
            tags=self.tags,
        )
        return MCPToolSchema(
            name=self.name,
            description=self.description,
            parameters=self.input_parameters,
            metadata=metadata,
            output_description=self.output_description,
            examples=self.examples,
        )
