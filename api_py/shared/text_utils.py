"""
Text formatting and HTML stripping utilities for the MCP agent.
Extracted from langchain_chatbot.py for reuse across layers.
"""

import re
from typing import Optional, List, Dict, Any

from bs4 import BeautifulSoup


def strip_html(text: Optional[str]) -> str:
    """Remove HTML tags and return clean text."""
    if not text:
        return ""
    try:
        return BeautifulSoup(text, "lxml").get_text(" ", strip=True)
    except Exception:
        try:
            return BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
        except Exception:
            return str(text)


def format_property_summary(properties: List[Dict[str, Any]]) -> str:
    """Format a list of properties into a compact summary for LLM context."""
    if not properties:
        return "No properties found."
    summary_lines = []
    for i, prop in enumerate(properties, 1):
        price_num = prop.get("price")
        price = (
            f"AED{price_num:,.0f}"
            if isinstance(price_num, (int, float))
            else "Price on request"
        )
        summary_lines.append(
            f"Index: {i}, ID: {prop.get('id')}, Title: {prop.get('title')}, "
            f"Price: {price}, Location: {prop.get('location')}"
        )
    return "\n".join(summary_lines)


def format_property_details(details: Dict[str, Any]) -> str:
    """Format detailed property information into readable text for LLM context."""
    if not details:
        return "No details available for this property."
    output_lines = []

    def format_value(val: Any) -> Optional[str]:
        if val is None or val == "":
            return None
        if isinstance(val, bool):
            return "Yes" if val else "No"
        if isinstance(val, (int, float)):
            if val > 100000:
                return f"AED {val:,.0f}"
            return str(val)
        return str(val)

    key_fields = ["title", "description", "description_html", "price"]
    for key in key_fields:
        if key in details:
            val = format_value(details[key])
            if val:
                key_title = key.replace("_", " ").title()
                if "description" in key:
                    output_lines.append(f"\n{key_title}:\n{strip_html(val)}")
                else:
                    output_lines.append(f"{key_title}: {val}")

    for key, value in details.items():
        if (
            key in key_fields
            or value is None
            or value == ""
            or key.startswith("lookup_")
            or "media" in key
        ):
            continue

        formatted_key = key.replace("_", " ").title()
        if isinstance(value, list) and value:
            if all(isinstance(item, dict) for item in value):
                if key.startswith("details_") and value[0]:
                    output_lines.append(f"\n{formatted_key}:")
                    for sub_key, sub_val in value[0].items():
                        if "id" not in sub_key and not isinstance(
                            sub_val, (dict, list)
                        ):
                            formatted_sub_val = format_value(sub_val)
                            if formatted_sub_val:
                                output_lines.append(
                                    f"  {sub_key.replace('_', ' ').title()}: {formatted_sub_val}"
                                )
                elif (
                    key == "faqs"
                    and all(
                        "question" in item and "answer" in item for item in value
                    )
                ):
                    output_lines.append("\nFAQs:")
                    for item in value:
                        output_lines.append(
                            f"  Q: {item.get('question')}\n  A: {item.get('answer')}"
                        )
                else:
                    items = [item.get("name") for item in value if item.get("name")]
                    if items:
                        output_lines.append(
                            f"{formatted_key}: {', '.join(items)}"
                        )
            elif all(isinstance(item, (str, int, float)) for item in value):
                items = [format_value(item) for item in value if item]
                if items:
                    output_lines.append(f"{formatted_key}: {', '.join(items)}")
        elif isinstance(value, dict) and value:
            output_lines.append(f"\n{formatted_key}:")
            for sub_key, sub_val in value.items():
                formatted_sub_val = format_value(sub_val)
                if formatted_sub_val:
                    output_lines.append(
                        f"  {sub_key.replace('_', ' ').title()}: {formatted_sub_val}"
                    )

    return "\n".join(output_lines)


def clean_query_for_text_search(query: str) -> str:
    """Remove common command phrases from a search query."""
    cleaned = re.sub(
        r"^(show me|find|search for|look up|give me|i want|tell me about)\s+",
        "",
        query,
        flags=re.IGNORECASE,
    )
    cleaned = cleaned.strip(" .,:;!?")
    return cleaned


def parse_price_text(text: str) -> Optional[float]:
    """Convert text like '1 million' or '50 lakhs' to float INR value."""
    text = text.lower().strip()
    match = re.search(r"([\d\.]+)", text)
    if not match:
        return None
    num = float(match.group(1))
    if "crore" in text or "cr" in text:
        return num * 10000000
    if "lakh" in text or "lac" in text:
        return num * 100000
    if "million" in text:
        return num * 1000000
    if "thousand" in text or "k" in text:
        return num * 1000
    return num
