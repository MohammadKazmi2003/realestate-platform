-- Supabase local seed: demo catalogue so a fresh PC has data out of the box.
-- 1 demo owner profile + 6 projects + 24 properties (14 residential, 6 commercial, 4 land)
-- with details rows and placeholder images. No real users, no PII.
-- Safe to re-run: every INSERT uses ON CONFLICT DO NOTHING.
-- Image URLs use placehold.co (already allow-listed in next.config.mjs).

BEGIN;

-- 1. Guarantee the lookup IDs referenced below exist (migrations normally seed these).
INSERT INTO public.roles (id, name) VALUES (2, 'property_owner') ON CONFLICT DO NOTHING;
INSERT INTO public.property_types (id, name) VALUES
  (1, 'Residential'), (2, 'Commercial'), (3, 'Land / Plot')
  ON CONFLICT DO NOTHING;
INSERT INTO public.lookup_listing_purposes (id, name) VALUES
  (1, 'Sell'), (2, 'Rent')
  ON CONFLICT DO NOTHING;
INSERT INTO public.lookup_ownership_types (id, name) VALUES
  (1, 'Freehold')
  ON CONFLICT DO NOTHING;
INSERT INTO public.lookup_availability_statuses (id, name) VALUES
  (1, 'Ready to move'), (4, 'Under Construction')
  ON CONFLICT DO NOTHING;
INSERT INTO public.bhk_types (id, label) VALUES
  (1, '1 BHK'), (2, '2 BHK'), (3, '3 BHK'), (4, '4 BHK')
  ON CONFLICT DO NOTHING;
INSERT INTO public.lookup_furnishing_statuses (id, name) VALUES
  (4, 'Fully Furnished'), (5, 'Semi Furnished'), (6, 'Unfurnished')
  ON CONFLICT DO NOTHING;

-- 2. Demo owner profile (NOT a real user; properties.user_id references profiles, not auth.users).
INSERT INTO public.profiles (id, name, email, phone_number, role_id) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Demo Owner', 'demo-owner@example.com', '+911234567890', 2)
  ON CONFLICT DO NOTHING;

-- 3. Demo projects.
INSERT INTO public.projects (id, name, builder_name, description, slug, construction_phase, low_price, high_price, price_currency, is_verified) VALUES
  ('22222222-2222-4222-8222-222222222201', 'Green Valley Apartments', 'Sunrise Developers', 'Gated residential community with clubhouse, pool and landscaped gardens in Whitefield.', 'green-valley-apartments-whitefield', 'Under Construction', 5500000, 16500000, 'INR', true),
  ('22222222-2222-4222-8222-222222222202', 'Palm Meadows Villas', 'Palm Estates', 'Row villas with private gardens and 24x7 security near Hinjewadi.', 'palm-meadows-villas-hinjewadi', 'Ready to Move', 27000000, 48000000, 'INR', true),
  ('22222222-2222-4222-8222-222222222203', 'Skyline Business Hub', 'Skyline Commercial', 'Grade-A office tower with high-speed lifts and 100 percent power backup in BKC.', 'skyline-business-hub-bkc', 'Ready to Move', 25000000, 90000000, 'INR', true),
  ('22222222-2222-4222-8222-222222222204', 'Lakeview Enclave Plots', 'Lakeview Landmarks', 'Plotted development with clear titles, wide roads and avenue plantation.', 'lakeview-enclave-plots-shamshabad', 'New Launch', 8000000, 32000000, 'INR', false),
  ('22222222-2222-4222-8222-222222222205', 'Harmony Heights', 'Harmony Builders', 'Family-focused towers with school and hospital within 2 km in Baner.', 'harmony-heights-baner', 'Under Construction', 5500000, 30000000, 'INR', true),
  ('22222222-2222-4222-8222-222222222206', 'Marina Bay Residences', 'Coromandel Homes', 'Sea-facing residences with podium amenities on ECR, Chennai.', 'marina-bay-residences-ecr', 'New Launch', 9800000, 45000000, 'INR', false)
  ON CONFLICT DO NOTHING;

-- 4. Demo properties (all status available, owned by the demo profile).
INSERT INTO public.properties (id, user_id, listing_purpose_id, property_type_id, title, description, price, location_text, availability_status_id, ownership_type_id, status) VALUES
  ('33333333-3333-4333-8333-333333333301', '11111111-1111-4111-8111-111111111111', 1, 1, '2 BHK Sunrise Apartment in Powai', 'Well ventilated 2 BHK with modular kitchen, covered parking and clubhouse access.', 14500000, 'Powai, Mumbai', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333302', '11111111-1111-4111-8111-111111111111', 1, 1, '3 BHK Garden Facing Flat in Baner', 'Garden facing 3 BHK on a higher floor with two covered car parks.', 9800000, 'Baner, Pune', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333303', '11111111-1111-4111-8111-111111111111', 1, 1, '1 BHK Cozy Home in Whitefield', 'Compact 1 BHK ideal for first buyers, 10 minutes from ITPL main gate.', 5500000, 'Whitefield, Bangalore', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333304', '11111111-1111-4111-8111-111111111111', 2, 1, '3 BHK Lake View Apartment for Rent in Powai', 'Furnished lake view 3 BHK available for family tenants from next month.', 85000, 'Powai, Mumbai', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333305', '11111111-1111-4111-8111-111111111111', 1, 1, '4 BHK Luxury Villa in Jubilee Hills', 'Gated villa with home theatre, terrace garden and staff quarters.', 45000000, 'Jubilee Hills, Hyderabad', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333306', '11111111-1111-4111-8111-111111111111', 2, 1, '2 BHK Family Home for Rent in Dwarka', 'Semi furnished 2 BHK near metro station, park facing balcony.', 32000, 'Dwarka, Delhi', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333307', '11111111-1111-4111-8111-111111111111', 1, 1, '1 BHK Budget Flat in Hadapsar', 'Budget friendly 1 BHK with lift, power backup and reserved parking.', 3800000, 'Hadapsar, Pune', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333308', '11111111-1111-4111-8111-111111111111', 1, 1, '3 BHK Park Facing Flat in Koramangala', 'Park facing 3 BHK with wooden flooring and utility balcony.', 22000000, 'Koramangala, Bangalore', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333309', '11111111-1111-4111-8111-111111111111', 1, 1, '2 BHK Sea Breeze Apartment in Andheri West', 'High floor 2 BHK with sea breeze, swimming pool and gym in society.', 18500000, 'Andheri West, Mumbai', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333310', '11111111-1111-4111-8111-111111111111', 1, 1, '4 BHK Penthouse in Lower Parel', 'Duplex penthouse with private terrace, skyline view and 3 car parks.', 75000000, 'Lower Parel, Mumbai', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333311', '11111111-1111-4111-8111-111111111111', 2, 1, '2 BHK Rented Flat near HITEC City', 'Gated community 2 BHK walking distance from HITEC City metro.', 30000, 'Madhapur, Hyderabad', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333312', '11111111-1111-4111-8111-111111111111', 1, 1, '3 BHK Independent Floor in Saket', 'Independent floor with separate entry, terrace rights and stilt parking.', 28000000, 'Saket, Delhi', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333313', '11111111-1111-4111-8111-111111111111', 2, 1, '1 BHK Rental in Marathahalli', 'Furnished 1 BHK for working professionals, close to Outer Ring Road.', 22000, 'Marathahalli, Bangalore', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333314', '11111111-1111-4111-8111-111111111111', 1, 1, '3 BHK New Launch in Kharadi', 'New launch tower with early bird pricing and flexible payment plan.', 11500000, 'Kharadi, Pune', 4, 1, 'available'),
  ('33333333-3333-4333-8333-333333333315', '11111111-1111-4111-8111-111111111111', 2, 2, 'Furnished Office Space in BKC', 'Plug and play office with 20 workstations, cabins and conference room.', 250000, 'BKC, Mumbai', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333316', '11111111-1111-4111-8111-111111111111', 1, 2, 'Retail Shop on MG Road', 'High footfall retail shop with 18 ft frontage on main MG Road.', 35000000, 'MG Road, Bangalore', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333317', '11111111-1111-4111-8111-111111111111', 2, 2, 'Office Space in HITEC City', 'Warm shell office with pantry, server room and visitor parking.', 150000, 'HITEC City, Hyderabad', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333318', '11111111-1111-4111-8111-111111111111', 1, 2, 'Pre-leased Office in Cyber City', 'Pre-leased office with 7 percent rental yield and 6 year lock in.', 60000000, 'Cyber City, Gurgaon', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333319', '11111111-1111-4111-8111-111111111111', 2, 2, 'Small Office in Andheri East', 'Compact office for startups near metro, with attached washroom.', 75000, 'Andheri East, Mumbai', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333320', '11111111-1111-4111-8111-111111111111', 1, 2, 'Showroom on FC Road', 'Double height showroom with glass facade on main FC Road.', 45000000, 'FC Road, Pune', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333321', '11111111-1111-4111-8111-111111111111', 1, 3, '5000 sqft Residential Plot in Wagholi', 'Clear title NA plot in gated layout with water and electricity lines.', 8000000, 'Wagholi, Pune', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333322', '11111111-1111-4111-8111-111111111111', 1, 3, '2 Acre Farm Plot near Shamshabad', 'Farm plot with borewell, farmhouse permission and road access.', 15000000, 'Shamshabad, Hyderabad', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333323', '11111111-1111-4111-8111-111111111111', 1, 3, '1200 sqyd Gated Plot in Jubilee Hills', 'Premium gated community plot with compound wall and security.', 32000000, 'Jubilee Hills, Hyderabad', 1, 1, 'available'),
  ('33333333-3333-4333-8333-333333333324', '11111111-1111-4111-8111-111111111111', 1, 3, '10000 sqft Commercial Plot on Hosur Road', 'Commercial zoning plot with 60 ft road frontage on Hosur Road.', 50000000, 'Hosur Road, Bangalore', 1, 1, 'available')
  ON CONFLICT DO NOTHING;

-- 5. Residential details for the 14 residential properties.
INSERT INTO public.details_residential (property_id, bhk_type_id, bathrooms, balconies, carpet_area, built_up_area, super_built_up_area, total_floors, property_on_floor, furnishing_status_id) VALUES
  ('33333333-3333-4333-8333-333333333301', 2, 2, 1, 950, 1150, 1350, 14, 7, 5),
  ('33333333-3333-4333-8333-333333333302', 3, 3, 2, 1250, 1500, 1750, 12, 9, 4),
  ('33333333-3333-4333-8333-333333333303', 1, 1, 1, 600, 720, 850, 10, 4, 6),
  ('33333333-3333-4333-8333-333333333304', 3, 3, 2, 1300, 1550, 1800, 20, 15, 4),
  ('33333333-3333-4333-8333-333333333305', 4, 5, 3, 3200, 3800, 4500, 2, 1, 4),
  ('33333333-3333-4333-8333-333333333306', 2, 2, 1, 900, 1050, 1200, 8, 3, 5),
  ('33333333-3333-4333-8333-333333333307', 1, 1, 1, 550, 650, 750, 7, 2, 6),
  ('33333333-3333-4333-8333-333333333308', 3, 2, 2, 1400, 1650, 1900, 15, 11, 5),
  ('33333333-3333-4333-8333-333333333309', 2, 2, 1, 1000, 1200, 1400, 22, 18, 5),
  ('33333333-3333-4333-8333-333333333310', 4, 5, 3, 2800, 3400, 4200, 30, 29, 4),
  ('33333333-3333-4333-8333-333333333311', 2, 2, 1, 950, 1100, 1250, 12, 6, 5),
  ('33333333-3333-4333-8333-333333333312', 3, 3, 2, 1600, 1900, 2200, 4, 2, 6),
  ('33333333-3333-4333-8333-333333333313', 1, 1, 1, 580, 680, 800, 9, 5, 4),
  ('33333333-3333-4333-8333-333333333314', 3, 2, 2, 1200, 1450, 1700, 18, 10, 6)
  ON CONFLICT DO NOTHING;

-- 6. Commercial details for the 6 commercial properties.
INSERT INTO public.details_commercial (property_id, min_seats, max_seats, cabins, meeting_rooms, private_washrooms, shared_washrooms, total_floors, property_on_floor, passenger_lifts, service_lifts, is_pre_leased, has_noc, has_occupancy_cert, carpet_area, furnishing_status_id) VALUES
  ('33333333-3333-4333-8333-333333333315', 15, 25, 2, 1, 1, 1, 12, 8, 4, 1, false, true, true, 1200, 4),
  ('33333333-3333-4333-8333-333333333316', NULL, NULL, 0, 0, 1, 0, 3, 1, 1, 0, false, true, true, 800, NULL),
  ('33333333-3333-4333-8333-333333333317', 10, 20, 1, 1, 1, 1, 10, 5, 3, 1, false, true, true, 1000, 5),
  ('33333333-3333-4333-8333-333333333318', 40, 60, 4, 2, 2, 2, 15, 10, 6, 2, true, true, true, 3000, 4),
  ('33333333-3333-4333-8333-333333333319', 4, 8, 1, 0, 0, 1, 6, 3, 2, 0, false, false, true, 450, 6),
  ('33333333-3333-4333-8333-333333333320', NULL, NULL, 0, 0, 1, 1, 2, 1, 1, 0, false, true, true, 1500, NULL)
  ON CONFLICT DO NOTHING;

-- 7. Land details for the 4 plots.
INSERT INTO public.details_land (property_id, plot_area, area_unit, is_boundary_wall_made) VALUES
  ('33333333-3333-4333-8333-333333333321', 5000, 'sqft', true),
  ('33333333-3333-4333-8333-333333333322', 2, 'acre', false),
  ('33333333-3333-4333-8333-333333333323', 1200, 'sqyd', true),
  ('33333333-3333-4333-8333-333333333324', 10000, 'sqft', false)
  ON CONFLICT DO NOTHING;

-- 8. One placeholder image per property (no storage bucket files needed).
INSERT INTO public.property_media (property_id, media_url, media_type, tag, display_order)
SELECT ('33333333-3333-4333-8333-3333333333' || lpad(g.n::text, 2, '0'))::uuid,
  'https://placehold.co/600x400?text=Property+' || g.n::text,
  'image', 'cover', 0
FROM generate_series(1, 24) AS g(n)
ON CONFLICT DO NOTHING;

COMMIT;
