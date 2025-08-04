-- This function safely updates the embedding for a single row in a specified table.
-- Using an RPC function for this operation is more robust than relying on the client
-- library's update method, as it prevents issues with NOT NULL constraints on other columns.

CREATE OR REPLACE FUNCTION update_embedding(
    p_table_name TEXT,
    p_row_id UUID,
    p_new_embedding VECTOR(768)
)
RETURNS VOID AS $$
BEGIN
    -- EXECUTE format() is used to safely construct and run dynamic SQL.
    -- %I is a placeholder for a table or column identifier (prevents SQL injection).
    -- %L is a placeholder for a literal value (properly quotes and escapes the value).
    EXECUTE format(
        'UPDATE public.%I SET description_embedding = %L WHERE id = %L',
        p_table_name,
        p_new_embedding,
        p_row_id
    );
END;
$$ LANGUAGE plpgsql;
