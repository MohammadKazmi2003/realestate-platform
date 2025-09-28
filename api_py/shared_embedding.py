# api_py/shared_embedding.py

from langchain_huggingface import HuggingFaceEmbeddings

# This is the single, shared instance of the embedding engine.
embedding_engine = HuggingFaceEmbeddings(
    model_name="nomic-ai/nomic-embed-text-v1",
    model_kwargs={"trust_remote_code": True},
)

