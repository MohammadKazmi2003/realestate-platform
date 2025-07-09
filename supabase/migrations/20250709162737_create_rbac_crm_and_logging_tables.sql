-- Create a table for user roles
CREATE TABLE public.roles (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

-- Populate the roles table
INSERT INTO public.roles (name) VALUES ('admin'), ('property_owner'), ('agent'), ('user');

-- Add a role_id column to the profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role_id int REFERENCES public.roles(id) DEFAULT 4;

-- Create a table for leads
CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text,
  phone text,
  message text,
  status text DEFAULT 'new',
  created_at timestamptz DEFAULT now()
);

-- Create a table for lead notes
CREATE TABLE public.lead_notes (
  id serial PRIMARY KEY,
  lead_id uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES auth.users(id),
  note text,
  created_at timestamptz DEFAULT now()
);

-- Create a table for appointments
CREATE TABLE public.appointments (
  id serial PRIMARY KEY,
  lead_id uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES auth.users(id),
  title text NOT NULL,
  description text,
  appointment_date timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Create a table for event logs
CREATE TABLE public.event_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  property_id uuid,
  event_type text,
  timestamp timestamptz DEFAULT now()
);

-- Create a table for action logs
CREATE TABLE public.action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  action text,
  entity_type text,
  entity_id uuid,
  timestamp timestamptz DEFAULT now()
);
