"""
MCP tool schema definitions.
Describes the structure of tool metadata, schemas, and examples.
"""

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ToolParameter:
    """Describes a single parameter for an MCP tool."""

    name: str
    type: str  # "string", "number", "integer", "boolean", "array", "object"
    description: str = ""
    required: bool = False
    default: Any = None
    enum: Optional[list[str]] = None
    examples: Optional[list[Any]] = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "name": self.name,
            "type": self.type,
            "description": self.description,
            "required": self.required,
        }
        if self.default is not None:
            d["default"] = self.default
        if self.enum:
            d["enum"] = self.enum
        if self.examples:
            d["examples"] = self.examples
        return d


@dataclass
class ToolExample:
    """An example input/output pair for a tool."""

    description: str
    input: dict[str, Any]
    output: Any = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {
            "description": self.description,
            "input": self.input,
        }
        if self.output is not None:
            d["output"] = self.output
        return d


@dataclass
class ToolMetadata:
    """Metadata about a tool for discovery and routing."""

    category: str  # e.g., "property_search", "property_details", "knowledge"
    when_to_use: str
    when_not_to_use: str
    version: str = "1.0.0"
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "category": self.category,
            "when_to_use": self.when_to_use,
            "when_not_to_use": self.when_not_to_use,
            "version": self.version,
            "tags": self.tags,
        }


@dataclass
class MCPToolSchema:
    """
    Complete schema for an MCP tool.
    Used for tool discovery, validation, and model-facing descriptions.
    """

    name: str
    description: str
    parameters: list[ToolParameter]
    metadata: ToolMetadata
    output_description: str = ""
    examples: list[ToolExample] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "version": self.metadata.version,
            "parameters": [p.to_dict() for p in self.parameters],
            "output_description": self.output_description,
            "examples": [e.to_dict() for e in self.examples],
            "metadata": self.metadata.to_dict(),
        }

    def to_json_schema(self) -> dict:
        """Convert to JSON Schema format for LLM function calling."""
        properties = {}
        required = []
        for param in self.parameters:
            prop: dict[str, Any] = {
                "type": param.type,
                "description": param.description,
            }
            if param.enum:
                prop["enum"] = param.enum
            if param.default is not None:
                prop["default"] = param.default
            properties[param.name] = prop
            if param.required:
                required.append(param.name)

        schema: dict[str, Any] = {
            "type": "object",
            "properties": properties,
        }
        if required:
            schema["required"] = required
        return schema

    def to_model_tool(self) -> dict:
        """Convert to the format expected by LLM function-calling APIs."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.to_json_schema(),
            },
        }
