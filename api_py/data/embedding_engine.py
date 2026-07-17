"""
Cached HuggingFace embedding engine.
Provides query embedding with TTL cache for repeated queries.
"""

import hashlib
import logging
import time
from threading import Lock

from api_py.shared.config import config

logger = logging.getLogger(__name__)

_engine = None
_engine_lock = Lock()
_cache: dict[str, tuple[float, list[float]]] = {}
_cache_lock = Lock()


def _get_engine():
    """Lazy-initialize the HuggingFace embedding model with thread safety."""
    global _engine
    if _engine is not None:
        return _engine

    with _engine_lock:
        # Double-check after acquiring lock
        if _engine is not None:
            return _engine

        from langchain_huggingface import HuggingFaceEmbeddings

        _engine = HuggingFaceEmbeddings(
            model_name="nomic-ai/nomic-embed-text-v1",
            model_kwargs={"trust_remote_code": True},
        )
        logger.info("HuggingFace embedding engine initialized (nomic-embed-text-v1).")
        return _engine


def embed_query(text: str) -> list[float]:
    """
    Generate an embedding vector for the given text.
    Uses a TTL cache to avoid redundant computations.

    Args:
        text: The text to embed.

    Returns:
        A list of floats representing the embedding vector.
    """
    cache_key = hashlib.sha256(text.encode()).hexdigest()

    with _cache_lock:
        entry = _cache.get(cache_key)
        if entry and entry[0] > time.time():
            return entry[1]

    engine = _get_engine()
    embedding = engine.embed_query(text)

    with _cache_lock:
        _cache[cache_key] = (time.time() + config.EMBEDDING_CACHE_TTL, embedding)
        if len(_cache) > 500:
            oldest = sorted(_cache.keys(), key=lambda k: _cache[k][0])
            for k in oldest[: len(oldest) // 2]:
                del _cache[k]

    return embedding
