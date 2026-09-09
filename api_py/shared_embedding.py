# api_py/shared_embedding.py
# Optional semantic embeddings. Disabled by default so `pip install` stays
# light (no torch / sentence-transformers) and Uvicorn never spawns
# SpawnProcess workers that crash on import.
# Core chat (structured SQL search + Groq LLM + Tavily) works without it;
# semantic fallback and session-memory similarity simply return empty.

import logging

logger = logging.getLogger(__name__)


class _DisabledEmbeddings:
    """Fallback when langchain-huggingface is not installed."""

    def embed_query(self, text: str):
        raise RuntimeError(
            "Semantic embeddings are disabled (langchain-huggingface not installed). "
            "Structured search still works."
        )

    def embed_documents(self, texts):
        raise RuntimeError("Semantic embeddings are disabled.")


def _load_engine():
    try:
        from langchain_huggingface import HuggingFaceEmbeddings

        engine = HuggingFaceEmbeddings(
            model_name="nomic-ai/nomic-embed-text-v1",
            model_kwargs={"trust_remote_code": True},
        )
        logger.info("Semantic embedding engine loaded.")
        return engine
    except Exception as e:
        logger.warning(
            "Semantic embeddings disabled: %s. "
            "Install with: pip install langchain-huggingface sentence-transformers torch",
            e,
        )
        return _DisabledEmbeddings()


# Single, shared instance. Never raises on import.
embedding_engine = _load_engine()

