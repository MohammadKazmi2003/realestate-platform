"""
Centralized configuration for the MCP architecture.
Supports configurable LLM providers (Groq, OpenAI, etc.).
"""

import os
from enum import Enum
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


class LLMProvider(str, Enum):
    GROQ = "groq"
    OPENAI = "openai"
    DEEPSEEK = "deepseek"
    MIMO = "mimo"


@dataclass(frozen=True)
class Config:
    # --- LLM Configuration (Configurable) ---
    LLM_PROVIDER: LLMProvider = field(
        default_factory=lambda: LLMProvider(os.getenv("LLM_PROVIDER", "groq"))
    )
    LLM_MODEL: str = field(
        default_factory=lambda: os.getenv("LLM_MODEL", "llama-3.1-8b-instant")
    )
    LLM_TEMPERATURE: float = field(
        default_factory=lambda: float(os.getenv("LLM_TEMPERATURE", "0"))
    )
    GROQ_API_KEY: str = field(
        default_factory=lambda: os.getenv("GROQ_API_KEY", "")
    )
    OPENAI_API_KEY: str = field(
        default_factory=lambda: os.getenv("OPENAI_API_KEY", "")
    )
    DEEPSEEK_API_KEY: str = field(
        default_factory=lambda: os.getenv("DEEPSEEK_API_KEY", "")
    )
    MIMO_API_KEY: str = field(
        default_factory=lambda: os.getenv("MIMO_API_KEY", "")
    )
    MIMO_BASE_URL: str = field(
        default_factory=lambda: os.getenv("MIMO_BASE_URL", "https://api.xiaomi.com/v1")
    )

    # --- Supabase ---
    SUPABASE_URL: str = field(
        default_factory=lambda: os.getenv("NEXT_PUBLIC_SUPABASE_URL", "")
    )
    SUPABASE_SERVICE_KEY: str = field(
        default_factory=lambda: os.getenv("SUPABASE_SERVICE_KEY", "")
    )

    # --- External Services ---
    TAVILY_API_KEY: str = field(
        default_factory=lambda: os.getenv("TAVILY_API_KEY", "")
    )

    # --- Server ---
    HOST: str = field(
        default_factory=lambda: os.getenv("HOST", "0.0.0.0")
    )
    PORT: int = field(
        default_factory=lambda: int(os.getenv("PORT", "8000"))
    )
    CORS_ORIGINS: list[str] = field(
        default_factory=lambda: os.getenv("CORS_ORIGINS", "*").split(",")
    )

    # --- Agent ---
    INTENT_HISTORY_LIMIT: int = 6
    RESPONSE_HISTORY_LIMIT: int = 10
    MEANINGFUL_QUERY_WORDS: int = 2
    MEANINGFUL_ANSWER_WORDS: int = 5

    # --- Rate Limiting ---
    RATE_LIMIT_MAX_REQUESTS: int = 30
    RATE_LIMIT_WINDOW_SECONDS: int = 60

    # --- Cache ---
    DETAIL_CACHE_TTL: int = 300
    PROJECT_DETAIL_CACHE_TTL: int = 300
    TEXT_SEARCH_CACHE_TTL: int = 60
    EMBEDDING_CACHE_TTL: int = 300


config = Config()
