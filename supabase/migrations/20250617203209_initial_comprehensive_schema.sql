-- ##################################################################
-- ## DEFINITIVE V4 COMPREHENSIVE SCHEMA (v2 - with PostGIS fix)
-- ##################################################################

-- ========= SECTION 0: ENABLE EXTENSIONS =========
-- This is the crucial fix. It enables the PostGIS extension which provides the 'geography' type.
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;


-- ========= SECTION 1: CORE TABLES =========

CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  builder_name text,
  description text,
  launch_date date,
  expected_completion_date date,
  project_area_sqft numeric,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.properties (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  project_id uuid REFERENCES public.projects(id),
  listing_purpose_id int NOT NULL,
  property_type_id int NOT NULL,
  title text NOT NULL,
  description text,
  price numeric(15, 2) NOT NULL,
  is_price_negotiable boolean DEFAULT false,
  is_price_inclusive boolean DEFAULT false,
  is_tax_excluded boolean DEFAULT false,
  location_text text,
  location_point geography(Point, 4326),
  availability_status_id int,
  ownership_type_id int,
  property_score int DEFAULT 0,
  status text DEFAULT 'available' NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);


-- ========= SECTION 2: LOOKUP TABLES (THE "DICTIONARIES") =========

CREATE TABLE public.bhk_types ( id serial PRIMARY KEY, label text NOT NULL UNIQUE );
CREATE TABLE public.property_types ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_listing_purposes ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_ownership_types ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_availability_statuses ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_furnishing_statuses ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_other_rooms ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_flooring_types ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_water_sources ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_overlooking_views ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_location_advantages ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_amenities ( id serial PRIMARY KEY, name text NOT NULL UNIQUE, category text, property_type_scope TEXT DEFAULT 'Both' NOT NULL );
CREATE TABLE public.lookup_safety_features ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_furnishing_items ( id serial PRIMARY KEY, name text NOT NULL UNIQUE, category text );
CREATE TABLE public.lookup_commercial_sub_types ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_commercial_office_types ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );
CREATE TABLE public.lookup_previous_office_uses ( id serial PRIMARY KEY, name text NOT NULL UNIQUE );

-- Add Foreign Key constraints now that all lookup tables are created
ALTER TABLE public.properties ADD FOREIGN KEY (listing_purpose_id) REFERENCES public.lookup_listing_purposes(id);
ALTER TABLE public.properties ADD FOREIGN KEY (property_type_id) REFERENCES public.property_types(id);
ALTER TABLE public.properties ADD FOREIGN KEY (availability_status_id) REFERENCES public.lookup_availability_statuses(id);
ALTER TABLE public.properties ADD FOREIGN KEY (ownership_type_id) REFERENCES public.lookup_ownership_types(id);


-- ========= SECTION 3: CONDITIONAL DETAIL TABLES =========

CREATE TABLE public.details_residential (
  property_id uuid PRIMARY KEY REFERENCES public.properties(id) ON DELETE CASCADE,
  bhk_type_id int REFERENCES public.bhk_types(id),
  bathrooms int,
  balconies int,
  carpet_area numeric,
  built_up_area numeric,
  super_built_up_area numeric,
  total_floors int,
  property_on_floor int,
  furnishing_status_id int REFERENCES public.lookup_furnishing_statuses(id),
  flooring_type_id int REFERENCES public.lookup_flooring_types(id),
  power_backup_status text
);

CREATE TABLE public.details_commercial (
  property_id uuid PRIMARY KEY REFERENCES public.properties(id) ON DELETE CASCADE,
  commercial_sub_type_id int REFERENCES public.lookup_commercial_sub_types(id),
  office_type_id int REFERENCES public.lookup_commercial_office_types(id),
  min_seats int,
  max_seats int,
  cabins int,
  meeting_rooms int,
  private_washrooms int,
  shared_washrooms int,
  pantry_type text,
  total_floors int,
  property_on_floor int,
  passenger_lifts int,
  service_lifts int,
  is_pre_leased boolean,
  has_noc boolean,
  has_occupancy_cert boolean
);


-- ========= SECTION 4: MEDIA AND JUNCTION TABLES =========

CREATE TABLE public.property_media (
  id serial PRIMARY KEY,
  property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  media_url text NOT NULL,
  media_type text NOT NULL,
  tag text,
  display_order int DEFAULT 0
);

CREATE TABLE public.junction_property_amenities ( property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE, amenity_id int NOT NULL REFERENCES public.lookup_amenities(id) ON DELETE CASCADE, PRIMARY KEY (property_id, amenity_id) );
CREATE TABLE public.junction_property_furnishings ( property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE, furnishing_item_id int NOT NULL REFERENCES public.lookup_furnishing_items(id) ON DELETE CASCADE, PRIMARY KEY (property_id, furnishing_item_id) );
CREATE TABLE public.junction_property_other_rooms ( property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE, room_id int NOT NULL REFERENCES public.lookup_other_rooms(id) ON DELETE CASCADE, PRIMARY KEY (property_id, room_id) );
CREATE TABLE public.junction_property_overlooking ( property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE, view_id int NOT NULL REFERENCES public.lookup_overlooking_views(id) ON DELETE CASCADE, PRIMARY KEY (property_id, view_id) );
CREATE TABLE public.junction_property_location_advantages ( property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE, advantage_id int NOT NULL REFERENCES public.lookup_location_advantages(id) ON DELETE CASCADE, PRIMARY KEY (property_id, advantage_id) );
CREATE TABLE public.junction_commercial_previous_uses ( property_id uuid NOT NULL REFERENCES public.details_commercial(property_id) ON DELETE CASCADE, use_id int NOT NULL REFERENCES public.lookup_previous_office_uses(id) ON DELETE CASCADE, PRIMARY KEY (property_id, use_id) );


-- ========= SECTION 5: POPULATE ALL LOOKUP TABLES =========

INSERT INTO public.property_types (name) VALUES ('Residential'), ('Commercial'), ('Land / Plot') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.bhk_types (label) VALUES ('1 BHK'), ('2 BHK'), ('3 BHK'), ('4 BHK'), ('4+ BHK'), ('1 RK / Studio') ON CONFLICT (label) DO NOTHING;
INSERT INTO public.lookup_listing_purposes (name) VALUES ('Sell'), ('Rent'), ('Lease'), ('PG') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.lookup_ownership_types (name) VALUES ('Freehold'), ('Leasehold'), ('Co-operative Society'), ('Power of Attorney') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.lookup_availability_statuses (name) VALUES ('Ready to move'), ('Under construction') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.lookup_furnishing_statuses (name) VALUES ('Furnished'), ('Semi-furnished'), ('Un-furnished') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.lookup_other_rooms (name) VALUES ('Pooja Room'), ('Study Room'), ('Servant Room'), ('Store Room') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.lookup_overlooking_views (name) VALUES ('Pool'), ('Park/Garden'), ('Club'), ('Main Road') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.lookup_location_advantages (name) VALUES ('Close to Metro'), ('Close to School'), ('Close to Hospital'), ('Close to Market'), ('Close to Airport'), ('Close to Mall'), ('Close to Highway') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.lookup_commercial_sub_types (name) VALUES ('Office'), ('Retail'), ('Storage'), ('Industry'), ('Hospitality') ON CONFLICT (name) DO NOTHING;
INSERT INTO public.lookup_commercial_office_types (name) VALUES ('Ready to move office space'), ('Bare shell office space'), ('Co-working office space') ON CONFLICT (name) DO NOTHING;

INSERT INTO public.lookup_amenities (name, category, property_type_scope) VALUES
  ('Maintenance Staff', 'Services', 'Both'), ('Water Storage', 'Utilities', 'Both'), ('Security / Fire Alarm', 'Security', 'Both'),
  ('Visitor Parking', 'Parking', 'Both'), ('Feng Shui / Vaastu Compliant', 'Other', 'Residential'), ('Park', 'Recreation', 'Residential'),
  ('Intercom Facility', 'Security', 'Both'), ('Lift(s)', 'Building', 'Both'), ('High Ceiling Height', 'Property Features', 'Residential'),
  ('False Ceiling Lighting', 'Property Features', 'Residential'), ('Piped-gas', 'Utilities', 'Residential'), ('Internet/Wi-Fi connectivity', 'Utilities', 'Both'),
  ('Centrally Air Conditioned', 'Property Features', 'Both'), ('Water purifier', 'Utilities', 'Residential'), ('Recently Renovated', 'Property Features', 'Both'),
  ('Private Garden / Terrace', 'Exterior', 'Residential'), ('Natural Light', 'Property Features', 'Both'), ('Airy Rooms', 'Property Features', 'Residential'),
  ('Spacious Interiors', 'Property Features', 'Residential'), ('Water softening plant', 'Society / Building', 'Both'), ('Shopping Centre', 'Society / Building', 'Both'),
  ('Fitness Centre / GYM', 'Society / Building', 'Both'), ('Swimming Pool', 'Society / Building', 'Residential'), ('Club house / Community Center', 'Society / Building', 'Both'),
  ('Security Personnel', 'Society / Building', 'Both'), ('Separate entry for servant room', 'Additional Features', 'Residential'), ('Waste Disposal', 'Additional Features', 'Both'),
  ('No open drainage around', 'Additional Features', 'Both'), ('Rain Water Harvesting', 'Additional Features', 'Both'),
  ('Conference Room', 'Office Features', 'Commercial'), ('Reception Area', 'Office Features', 'Commercial'), ('Director Cabin', 'Office Features', 'Commercial')
ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category, property_type_scope = EXCLUDED.property_type_scope;