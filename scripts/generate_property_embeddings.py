"""
One-time script to generate embeddings for all properties.
Run after the embedding engine is set up.

Usage: python scripts/generate_property_embeddings.py
"""

import sys
import os
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_py.data.supabase_client import get_supabase_client
from api_py.data.embedding_engine import embed_query


async def main():
    client = get_supabase_client()

    result = client.table("properties").select("id, title, description").execute()
    properties = result.data

    print(f"Generating embeddings for {len(properties)} properties...")

    count = 0
    for i, prop in enumerate(properties):
        text = f"{prop['title'] or ''} {prop['description'] or ''}".strip()
        if not text:
            continue

        embedding = embed_query(text)

        client.table("properties").update({
            "description_embedding": embedding
        }).eq("id", prop["id"]).execute()

        count += 1
        print(f"  [{i + 1}/{len(properties)}] {prop['title'][:60]}...")

    print(f"Done. Generated {count} embeddings.")


if __name__ == "__main__":
    asyncio.run(main())
