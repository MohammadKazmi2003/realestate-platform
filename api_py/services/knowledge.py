"""
Knowledge search service.
Handles general real estate Q&A via web search.
"""

import logging
from typing import Any

from api_py.shared.config import config

logger = logging.getLogger(__name__)


class KnowledgeService:
    """Handles general knowledge queries via web search."""

    def __init__(self):
        self._tavily_client = None

    def _get_tavily_client(self):
        """Lazy-initialize the Tavily search client."""
        if self._tavily_client is None:
            from langchain_community.tools.tavily_search import TavilySearchResults

            if not config.TAVILY_API_KEY:
                raise ValueError("TAVILY_API_KEY is not configured.")
            self._tavily_client = TavilySearchResults(
                max_results=3, api_key=config.TAVILY_API_KEY
            )
        return self._tavily_client

    async def web_search(self, query: str) -> str:
        """
        Search the web for general real estate knowledge.

        Args:
            query: The question to search for (e.g., "what is stamp duty in Gurgaon?").

        Returns:
            Concatenated search result contents.
        """
        logger.info(f"knowledge_web_search for query: '{query}'")

        if not config.TAVILY_API_KEY:
            return "Error: Knowledge search is not configured."

        try:
            tavily = self._get_tavily_client()
            results = await tavily.ainvoke(query)
            return "\n".join([res["content"] for res in results])
        except Exception as e:
            logger.error(f"knowledge_web_search error: {e}")
            return f"Error: An error occurred while searching the web: {e}"
