-- Add hierarchical parent relationship to property_types.
-- Parent categories: Residential, Commercial, Land / Plot
-- Sub-types: Residential Apartment, Independent House/Villa → Residential
--            Commercial Office, Commercial Retail → Commercial

alter table public.property_types
  add column if not exists parent_id int references public.property_types(id);

-- Backfill: set parent_id based on name prefix
update public.property_types set parent_id = 1 where name ilike 'Residential%' and id != 1;
update public.property_types set parent_id = 1 where name ilike '%House%' or name ilike '%Villa%';
update public.property_types set parent_id = 2 where name ilike 'Commercial%' and id != 2;
