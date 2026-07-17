"""
Session memory service.
Handles storing and retrieving conversational memory via pgvector.
"""

import asyncio
import logging
from typing import Optional

from api_py.data.supabase_client import rpc_call
from api_py.data.embedding_engine import embed_query

logger = logging.getLogger(__name__)


class SessionMemoryService:
    """Handles session memory storage and retrieval via pgvector."""

    async def store_memory(self, session_id: str, text_content: str) -> None:
        """
        Store a conversational exchange in session memory.

        Args:
            session_id: The unique session identifier.
            text_content: The text to store (e.g., "User: ...\nBot: ...").
        """
        try:
            embedding = await asyncio.to_thread(embed_query, text_content)

            await rpc_call(
                "store_session_memory",
                {
                    "p_session_id": session_id,
                    "p_text_content": text_content,
                    "p_embedding": embedding,
                },
            )
            logger.info(f"Stored memory for session {session_id}.")
        except Exception as e:
            logger.error(f"Failed to store memory for {session_id}: {e}", exc_info=True)

    async def search_memory(
        self, session_id: str, query_text: str, k: int = 3
    ) -> list[str]:
        """
        Search for relevant past exchanges in session memory.

        Args:
            session_id: The session to search within.
            query_text: The query to match against.
            k: Number of results to return.

        Returns:
            List of text content strings from matching memories.
        """
        try:
            query_vec = await asyncio.to_thread(embed_query, query_text)

            response = await rpc_call(
                "search_session_memory",
                {
                    "p_session_id": session_id,
                    "p_query_vec": query_vec,
                    "p_k": k,
                },
            )

            if response:
                return [item["text_content"] for item in response]
            return []

        except Exception as e:
            logger.error(f"Failed to search memory for {session_id}: {e}", exc_info=True)
            return []
