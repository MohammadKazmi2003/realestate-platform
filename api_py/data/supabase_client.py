"""
Supabase client singleton with helper methods.
All database access goes through this client.
"""

import asyncio
import logging
from typing import Any, Optional

from supabase import create_client, Client

from api_py.shared.config import config

logger = logging.getLogger(__name__)

_client: Optional[Client] = None


def get_supabase_client() -> Client:
    """Return the singleton Supabase client, creating it if needed."""
    global _client
    if _client is None:
        if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
            raise ValueError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set."
            )
        _client = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
        logger.info("Supabase client initialized.")
    return _client


async def rpc_call(function_name: str, params: dict[str, Any]) -> Any:
    """
    Execute a Supabase RPC function call asynchronously.

    Args:
        function_name: The PostgreSQL function name to call.
        params: Parameters to pass to the RPC function.

    Returns:
        The response data from the RPC call.
    """
    client = get_supabase_client()
    response = await asyncio.to_thread(
        client.rpc(function_name, params).execute
    )
    return response.data


async def table_query(
    table_name: str,
    columns: str = "*",
    filters: Optional[dict[str, Any]] = None,
    limit: Optional[int] = None,
) -> Any:
    """
    Query a Supabase table asynchronously.

    Args:
        table_name: The table to query.
        columns: Column selection string.
        filters: Dict of column/value filters.
        limit: Maximum rows to return.

    Returns:
        The response data.
    """
    client = get_supabase_client()
    query = client.from_(table_name).select(columns)

    if filters:
        for key, value in filters.items():
            if isinstance(value, list):
                query = query.in_(key, value)
            else:
                query = query.eq(key, value)

    if limit:
        query = query.limit(limit)

    response = await asyncio.to_thread(query.execute)
    return response.data
