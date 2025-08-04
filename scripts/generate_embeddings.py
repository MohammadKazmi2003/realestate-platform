import os
import dotenv
from supabase import create_client, Client
from sentence_transformers import SentenceTransformer
import numpy as np

# --- CONFIGURATION ---
# Load environment variables from a .env file
dotenv.load_dotenv()

# Supabase credentials
SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

# Embedding model configuration
# NOTE: This model produces 768-dimensional vectors. Your database schema must match.
MODEL_NAME = 'nomic-ai/nomic-embed-text-v1'
BATCH_SIZE = 5  # Define the batch size explicitly

# --- INITIALIZATION ---
try:
    # Initialize Supabase client
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise ValueError("Supabase URL and Service Key must be set in environment variables.")
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    # Initialize the sentence-transformer model
    print(f"Loading sentence-transformer model: '{MODEL_NAME}'...")
    model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)
    print("Model loaded successfully.")

except Exception as e:
    print(f"Error during initialization: {e}")
    exit(1)


def process_table(table_name: str, description_column: str, id_column: str = 'id'):
    """
    Fetches records from a table, generates embeddings for a specified text column,
    and updates the 'description_embedding' column in batches.

    Args:
        table_name (str): The name of the table to process (e.g., 'properties').
        description_column (str): The name of the column containing the text to embed.
        id_column (str): The name of the primary key column.
    """
    print(f"\n--- Processing table: {table_name} ---")

    # Fetch all rows that have NULL in description_embedding
    response = supabase.table(table_name)\
        .select(f"{id_column}, {description_column}")\
        .is_('description_embedding', None)\
        .neq(description_column, 'is.null')\
        .limit(2000).execute()

    records = response.data
    print(f"Fetched {len(records)} records needing embeddings.")

    if not records:
        print("\u2705 No missing embeddings found.")
        return

    total_updated = 0

    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i + BATCH_SIZE]
        texts = [r[description_column] for r in batch]
        ids = [r[id_column] for r in batch]

        print(f"Embedding batch {i // BATCH_SIZE + 1}...")

        try:
            embeddings = model.encode(texts, convert_to_numpy=True)
            for record_id, embedding in zip(ids, embeddings):
                supabase.rpc("update_embedding", {
                    "p_table_name": table_name,
                    "p_row_id": record_id,
                    "p_new_embedding": embedding.tolist()
                }).execute()
            total_updated += len(batch)
        except Exception as e:
            print(f"\u274C Error in batch {i}: {e}")

    print(f"\u2705 Done processing '{table_name}'. Total updated: {total_updated}")


def main():
    """
    Main function to run the backfill script for all specified tables.

    IMPORTANT: This script now relies on a Supabase function called `update_embedding`.
    Please create a new migration and apply it BEFORE running this script.
    See the associated migration file for the SQL code.
    """
    print("Starting embedding backfill process...")

    process_table(
        table_name='properties',
        description_column='description'
    )

    process_table(
        table_name='projects',
        description_column='description_html'
    )

    print("\nEmbedding backfill complete for all tables.")


if __name__ == "__main__":
    main()
