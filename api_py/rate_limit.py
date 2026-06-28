import time
import hashlib
from collections import defaultdict
from threading import Lock

class RateLimiter:
    def __init__(self, max_requests: int = 30, window_seconds: int = 60):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests: dict[str, list[float]] = defaultdict(list)
        self._lock = Lock()

    def is_allowed(self, identifier: str) -> bool:
        now = time.time()
        window_start = now - self.window_seconds

        with self._lock:
            bucket = self.requests[identifier]
            self.requests[identifier] = [t for t in bucket if t > window_start]

            if len(self.requests[identifier]) >= self.max_requests:
                return False

            self.requests[identifier].append(now)

            if len(self.requests) > 10000:
                self.requests = defaultdict(
                    list,
                    {k: v for k, v in self.requests.items() if any(t > window_start for t in v)},
                )

            return True

chat_rate_limiter = RateLimiter(max_requests=30, window_seconds=60)
