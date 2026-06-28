import time
import hashlib
from threading import Lock
from langchain_huggingface import HuggingFaceEmbeddings

class _CachedEmbeddingEngine:
    def __init__(self, ttl_seconds: int = 300, max_size: int = 500):
        self._engine = HuggingFaceEmbeddings(
            model_name="nomic-ai/nomic-embed-text-v1",
            model_kwargs={"trust_remote_code": True},
        )
        self._cache: dict[str, tuple[float, list[float]]] = {}
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._lock = Lock()

    def embed_query(self, text: str) -> list[float]:
        cache_key = hashlib.sha256(text.encode()).hexdigest()
        with self._lock:
            entry = self._cache.get(cache_key)
            if entry and entry[0] > time.time():
                return entry[1]

        embedding = self._engine.embed_query(text)

        with self._lock:
            self._cache[cache_key] = (time.time() + self._ttl, embedding)
            if len(self._cache) > self._max_size:
                oldest = sorted(self._cache.keys(), key=lambda k: self._cache[k][0])
                for k in oldest[:len(oldest) // 2]:
                    del self._cache[k]
        return embedding

embedding_engine = _CachedEmbeddingEngine()
