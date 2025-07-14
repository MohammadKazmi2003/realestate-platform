-- This migration adds the 'metadata' column to the 'action_logs' table,
-- which is required by the updated log_action function.

-- Add a 'metadata' column of type JSONB to the action_logs table.
-- JSONB is efficient for storing and querying structured data.
-- The "IF NOT EXISTS" clause makes this script safe to run even if the column was added manually.
ALTER TABLE public.action_logs
ADD COLUMN IF NOT EXISTS metadata jsonb;
