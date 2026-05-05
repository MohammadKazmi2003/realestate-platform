# api_py/vector_store.py
"""
This file contains the ChatVectorStore class, an abstraction layer
to handle all database interactions and embedding logic for session memory.
This keeps the main chatbot code clean and portable.
"""

import logging
import asyncio
from supabase import Client
from langchain_community.embeddings import HuggingFaceEmbeddings

# Get the logger instance
logger = logging.getLogger(__name__)

class ChatVectorStore:
    """
    A class to abstract the storage and retrieval of chat session memory
    from a Supabase pgvector database.
    """

    def __init__(self, supabase_client: Client, embedding_model: HuggingFaceEmbeddings):
        """
        Initializes the vector store with a Supabase client and an embedding model.

        Args:
            supabase_client: An initialized Supabase client instance.
            embedding_model: An initialized HuggingFaceEmbeddings instance.
        """
        self.db = supabase_client
        self.embedding_model = embedding_model
        logger.info("ChatVectorStore initialized.")

    async def store_memory(self, session_id: str, text_content: str):
        """
        Generates an embedding for the given text and stores it in the
        session_memory table associated with the session_id.

        Args:
            session_id: The unique identifier for the user's session.
            text_content: The conversational exchange (e.g., "User: ...\nBot: ...") to store.
        """
        try:
            logger.info(f"Generating embedding for session {session_id}...")
            # Generate embedding in a thread-safe manner for asyncio
            embedding = await asyncio.to_thread(self.embedding_model.embed_query, text_content)
            
            logger.info(f"Storing memory for session {session_id}...")
            # Call the RPC function to store the memory
            await asyncio.to_thread(
                self.db.rpc(
                    "store_session_memory",
                    {
                        "p_session_id": session_id,
                        "p_text_content": text_content,
                        "p_embedding": embedding,
                    },
                ).execute
            )
            logger.info(f"Successfully stored memory for session {session_id}.")
        except Exception as e:
            # Log errors but don't crash the main chat flow
            logger.error(f"Failed to store session memory for {session_id}: {e}", exc_info=True)

    async def search_memory(self, session_id: str, query_text: str, k: int = 3) -> list[str]:
        """
        Searches the session_memory table for the k most similar past exchanges
        for a given session_id.

        Args:
            session_id: The unique identifier for the user's session.
            query_text: The latest user query to search against.
            k: The number of similar exchanges to retrieve.

        Returns:
            A list of strings, where each string is a past conversational exchange.
            Returns an empty list if an error occurs or no results are found.
        """
        try:
            logger.info(f"Generating query vector for session {session_id}...")
            # Generate query vector in a thread-safe manner
            query_vec = await asyncio.to_thread(self.embedding_model.embed_query, query_text)

            logger.info(f"Searching memory for session {session_id} with k={k}...")
            # Call the RPC function to search for similar memories
            response = await asyncio.to_thread(
                self.db.rpc(
                    "search_session_memory",
                    {
                        "p_session_id": session_id,
                        "p_query_vec": query_vec,
                        "p_k": k,
                    },
                ).execute
            )

            if response.data:
                logger.info(f"Found {len(response.data)} relevant memories for session {session_id}.")
                # Parse the database response and return only the text content
                return [item['text_content'] for item in response.data]
            else:
                logger.info(f"No relevant memories found for session {session_id}.")
                return []
        except Exception as e:
            logger.error(f"Failed to search session memory for {session_id}: {e}", exc_info=True)
            return []  # Return empty list on failure
