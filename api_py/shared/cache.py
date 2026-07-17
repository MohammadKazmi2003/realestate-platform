"""
Thread-safe TTL cache with automatic eviction.
Used for caching tool results, embeddings, and search results.
"""

import time
from threading import Lock
from typing import Any, Optional


class TTLCache:
    def __init__(self, ttl_seconds: int = 300, max_size: int = 500):
        self._store: dict[str, tuple[float, Any]] = {}
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._lock = Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            entry = self._store.get(key)
            if entry and entry[0] > time.time():
                return entry[1]
            if entry:
                del self._store[key]
            return None

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._store[key] = (time.time() + self._ttl, value)
            self._evict_expired()
            self._evict_oldest_if_full()

    def delete(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()

    def _evict_expired(self) -> None:
        now = time.time()
        expired = [k for k, v in self._store.items() if v[0] <= now]
        for k in expired:
            del self._store[k]

    def _evict_oldest_if_full(self) -> None:
        if len(self._store) > self._max_size:
            oldest = sorted(self._store.keys(), key=lambda k: self._store[k][0])
            for k in oldest[: len(oldest) // 2]:
                del self._store[k]

    def __len__(self) -> int:
        with self._lock:
            return len(self._store)

    def __contains__(self, key: str) -> bool:
        return self.get(key) is not None
