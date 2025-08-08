-- This migration creates the necessary table for chunk-based semantic search.

-- Step 1: Create the table to hold the text chunks and their embeddings.
CREATE TABLE public.property_chunks (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    property_id UUID REFERENCES public.properties(id) ON DELETE CASCADE,
    project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
    chunk_text TEXT NOT NULL,
    embedding VECTOR(768),
    CONSTRAINT fk_property_or_project CHECK (
        (property_id IS NOT NULL AND project_id IS NULL) OR
        (property_id IS NULL AND project_id IS NOT NULL)
    )
);

-- Step 2: Create an index for fast similarity search on the new table.
CREATE INDEX ON public.property_chunks
USING ivfflat (embedding vector_l2_ops)
WITH (lists = 100);

-- Step 3: Enable Row Level Security for the new table.
ALTER TABLE public.property_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access for property_chunks" ON public.property_chunks FOR SELECT USING (true);