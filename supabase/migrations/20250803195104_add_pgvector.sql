-- Enable the vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to the 'properties' table
-- The size (1536) should match the output dimensions of your chosen embedding model.
-- OpenAI's text-embedding-3-small uses 1536.
ALTER TABLE public.properties
ADD COLUMN description_embedding vector(1536);

-- Add embedding column to the 'projects' table
ALTER TABLE public.projects
ADD COLUMN description_embedding vector(1536);

-- Create an IVFFlat index on the 'properties' table for faster similarity searches.
-- The `lists` parameter is a trade-off between build time and query speed.
-- A good starting point is lists = 4 * sqrt(number_of_rows).
-- For 10,000 rows, sqrt(10000) = 100, so lists = 400. We'll start with 100.
CREATE INDEX ON public.properties
USING ivfflat (description_embedding vector_l2_ops)
WITH (lists = 100);

-- Create a similar index on the 'projects' table.
CREATE INDEX ON public.projects
USING ivfflat (description_embedding vector_l2_ops)
WITH (lists = 100);
