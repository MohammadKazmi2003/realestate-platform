"""
In-memory sliding window rate limiter.
Uses time-based cleanup to prevent memory leaks.
"""

import time
from threading import Lock


class RateLimiter:
    def __init__(self, max_requests: int = 30, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests: dict[str, list[float]] = {}
        self._lock = Lock()
        self._last_cleanup = time.time()
        self._cleanup_interval = 300  # Cleanup every 5 minutes

    def is_allowed(self, identifier: str) -> bool:
        now = time.time()
        window_start = now - self.window_seconds

        with self._lock:
            # Periodic cleanup of expired buckets
            if now - self._last_cleanup > self._cleanup_interval:
                self._cleanup_expired(window_start)
                self._last_cleanup = now

            bucket = self.requests.get(identifier, [])
            # Filter to only recent requests
            bucket = [t for t in bucket if t > window_start]
            self.requests[identifier] = bucket

            if len(bucket) >= self.max_requests:
                return False

            bucket.append(now)
            return True

    def _cleanup_expired(self, window_start: float) -> None:
        """Remove buckets with no recent requests."""
        empty_keys = []
        for key, timestamps in self.requests.items():
            # Keep only recent timestamps
            recent = [t for t in timestamps if t > window_start]
            if recent:
                self.requests[key] = recent
            else:
                empty_keys.append(key)

        for key in empty_keys:
            del self.requests[key]

    def reset(self, identifier: str) -> None:
        with self._lock:
            self.requests.pop(identifier, None)
