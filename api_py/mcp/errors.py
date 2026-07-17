"""
MCP error hierarchy.
Provides structured errors with codes, messages, and details.
"""

from typing import Any, Optional


class MCPError(Exception):
    """Base error for all MCP operations."""

    def __init__(
        self,
        message: str,
        code: str = "MCP_ERROR",
        details: Optional[Any] = None,
    ):
        self.message = message
        self.code = code
        self.details = details
        super().__init__(self.message)

    def to_dict(self) -> dict:
        return {
            "error": True,
            "code": self.code,
            "message": self.message,
            "details": self.details,
        }


class ToolNotFoundError(MCPError):
    """Raised when a requested tool is not registered."""

    def __init__(self, tool_name: str):
        super().__init__(
            message=f"Tool '{tool_name}' not found.",
            code="TOOL_NOT_FOUND",
            details={"tool_name": tool_name},
        )


class ToolValidationError(MCPError):
    """Raised when tool input fails schema validation."""

    def __init__(self, tool_name: str, validation_errors: Any):
        super().__init__(
            message=f"Validation failed for tool '{tool_name}'.",
            code="TOOL_VALIDATION_ERROR",
            details={"tool_name": tool_name, "errors": validation_errors},
        )


class ToolExecutionError(MCPError):
    """Raised when a tool execution fails."""

    def __init__(self, tool_name: str, original_error: Exception):
        super().__init__(
            message=f"Error executing tool '{tool_name}': {original_error}",
            code="TOOL_EXECUTION_ERROR",
            details={"tool_name": tool_name, "original_error": str(original_error)},
        )


class ToolTimeoutError(MCPError):
    """Raised when a tool execution times out."""

    def __init__(self, tool_name: str, timeout_seconds: float):
        super().__init__(
            message=f"Tool '{tool_name}' timed out after {timeout_seconds}s.",
            code="TOOL_TIMEOUT",
            details={"tool_name": tool_name, "timeout_seconds": timeout_seconds},
        )
