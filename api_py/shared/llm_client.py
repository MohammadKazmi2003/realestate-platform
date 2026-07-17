"""
Shared LLM client factory.
Provides async LLM clients for Groq and OpenAI providers.
"""

import logging
from typing import Any, Optional

from api_py.shared.config import config

logger = logging.getLogger(__name__)

_client = None


async def get_llm_client():
    """
    Get or create the async LLM client based on config.
    Returns a singleton client for the configured provider.
    """
    global _client
    if _client is not None:
        return _client

    if config.LLM_PROVIDER.value == "groq":
        from groq import AsyncGroq
        _client = AsyncGroq(api_key=config.GROQ_API_KEY)
    elif config.LLM_PROVIDER.value == "openai":
        from openai import AsyncOpenAI
        _client = AsyncOpenAI(api_key=config.OPENAI_API_KEY)
    else:
        raise ValueError(f"Unsupported LLM provider: {config.LLM_PROVIDER}")

    logger.info(f"LLM client initialized: {config.LLM_PROVIDER.value}")
    return _client


def get_model_name() -> str:
    """Get the model name for the current provider."""
    if config.LLM_PROVIDER.value == "groq":
        return config.LLM_MODEL
    elif config.LLM_PROVIDER.value == "openai":
        return config.LLM_MODEL or "gpt-4o-mini"
    return config.LLM_MODEL


async def llm_chat(
    system_prompt: str,
    user_prompt: str,
    temperature: Optional[float] = None,
    response_format: Optional[dict] = None,
) -> str:
    """
    Convenience function for a simple LLM chat completion.

    Args:
        system_prompt: System message content.
        user_prompt: User message content.
        temperature: Override config temperature if provided.
        response_format: Optional response format (e.g., {"type": "json_object"}).

    Returns:
        The LLM response content string.
    """
    client = await get_llm_client()
    model = get_model_name()
    temp = temperature if temperature is not None else config.LLM_TEMPERATURE

    kwargs: dict[str, Any] = {
        "model": model,
        "temperature": temp,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if response_format:
        kwargs["response_format"] = response_format

    response = await client.chat.completions.create(**kwargs)
    return response.choices[0].message.content or ""
