-- Enable RLS for all new tables
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.action_logs ENABLE ROW LEVEL SECURITY;

-- POLICIES FOR 'leads' TABLE
CREATE POLICY "Allow admin to access all leads" ON public.leads FOR ALL
  USING ( (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 1 );

CREATE POLICY "Allow property owners to see leads for their properties" ON public.leads FOR SELECT
  USING ( (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 2 AND property_id IN (SELECT id FROM public.properties WHERE user_id = auth.uid()) );

CREATE POLICY "Allow agents to manage leads" ON public.leads FOR ALL
  USING ( (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 3 );

-- POLICIES FOR 'appointments' TABLE
CREATE POLICY "Agents can manage their own appointments" ON public.appointments FOR ALL
  USING ( (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 3 AND agent_id = auth.uid() );

CREATE POLICY "Admins can access all appointments" ON public.appointments FOR ALL
  USING ( (SELECT role_id FROM public.profiles WHERE id = auth.uid()) = 1 );

-- Add other policies for lead_notes, event_logs, and action_logs as needed...
