"""
MCP Tool Dispatcher.
Validates input, executes tools, validates output, and serializes results.
"""

import asyncio
import json
import logging
import time
from typing import Any, Optional

from pydantic import BaseModel, ValidationError

from api_py.mcp.schemas import MCPToolSchema
from api_py.mcp.errors import ToolValidationError, ToolExecutionError, ToolTimeoutError

logger = logging.getLogger(__name__)


class MCPToolDispatcher:
    """
    Dispatches tool executions with validation and error handling.
    Tools are registered as callables; dispatch validates input and output.
    """

    def __init__(self):
        self._handlers: dict[str, Any] = {}

    def register_handler(self, tool_name: str, handler: Any) -> None:
        """Register a tool handler (an MCPTool instance or callable)."""
        self._handlers[tool_name] = handler
        logger.debug(f"Registered handler for tool: {tool_name}")

    def has_handler(self, tool_name: str) -> bool:
        return tool_name in self._handlers

    async def execute(
        self,
        tool_name: str,
        params: dict[str, Any],
        schema: Optional[MCPToolSchema] = None,
        timeout: float = 30.0,
    ) -> Any:
        """
        Execute a tool with validation and error handling.

        Args:
            tool_name: Name of the tool to execute.
            params: Input parameters.
            schema: Optional schema for input validation.
            timeout: Maximum execution time in seconds.

        Returns:
            Serialized JSON string of the tool result.

        Raises:
            ToolValidationError: If input validation fails.
            ToolExecutionError: If tool execution fails.
            ToolTimeoutError: If execution times out.
        """
        handler = self._handlers.get(tool_name)
        if handler is None:
            raise ToolExecutionError(
                tool_name,
                ValueError(f"No handler registered for '{tool_name}'"),
            )

        # Validate input if schema is provided
        if schema:
            self._validate_input(tool_name, params, schema)

        # Execute with timeout tracking
        start_time = time.time()
        try:
            if hasattr(handler, "execute"):
                result = await handler.execute(params)
            elif callable(handler):
                result = await asyncio.wait_for(
                    handler(**params), timeout=timeout
                )
            else:
                raise ToolExecutionError(
                    tool_name,
                    ValueError(f"Handler for '{tool_name}' is not callable"),
                )

            elapsed = time.time() - start_time
            if elapsed > timeout:
                logger.warning(
                    f"Tool '{tool_name}' took {elapsed:.2f}s (timeout: {timeout}s)"
                )

            logger.info(
                f"Tool '{tool_name}' executed in {elapsed:.3f}s"
            )

            # Serialize result to JSON string
            if isinstance(result, str):
                return result
            return json.dumps(result, default=str)

        except asyncio.TimeoutError:
            raise ToolTimeoutError(tool_name, timeout)
        except ToolValidationError:
            raise
        except Exception as e:
            raise ToolExecutionError(tool_name, e)

    def _validate_input(
        self, tool_name: str, params: dict[str, Any], schema: MCPToolSchema
    ) -> None:
        """Validate input parameters against the tool's schema."""
        errors = []
        for param in schema.parameters:
            value = params.get(param.name)
            if param.required and value is None:
                errors.append(f"Missing required parameter: '{param.name}'")
            if value is not None and param.enum:
                if value not in param.enum:
                    errors.append(
                        f"Invalid value for '{param.name}': "
                        f"must be one of {param.enum}, got '{value}'"
                    )

        if errors:
            raise ToolValidationError(tool_name, errors)
