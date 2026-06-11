-- Seed data for development and testing
-- Run: supabase db reset (this runs after migrations)

-- Insert lookup data if not already present
INSERT INTO public.bhk_types (label) VALUES
  ('1 BHK'), ('1.5 BHK'), ('2 BHK'), ('2.5 BHK'), ('3 BHK'),
  ('3.5 BHK'), ('4 BHK'), ('5 BHK'), ('6+ BHK'), ('Studio')
ON CONFLICT (label) DO NOTHING;

INSERT INTO public.property_types (name) VALUES
  ('Residential Apartment'), ('Independent House/Villa'),
  ('Commercial Office'), ('Commercial Retail'), ('Land / Plot')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.lookup_listing_purposes (name) VALUES
  ('Sale'), ('Rent'), ('Lease'), ('PG')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.lookup_availability_statuses (name) VALUES
  ('Ready to Move'), ('Under Construction'), ('New Launch')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.lookup_ownership_types (name) VALUES
  ('Freehold'), ('Leasehold'), ('Co-operative Society'), ('Power of Attorney')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.lookup_furnishing_statuses (name) VALUES
  ('Fully Furnished'), ('Semi Furnished'), ('Unfurnished')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.lookup_amenities (name, category) VALUES
  ('Swimming Pool', 'Recreation'), ('Gym', 'Recreation'), ('Club House', 'Recreation'),
  ('Children Play Area', 'Recreation'), ('Jogging Track', 'Recreation'),
  ('24x7 Security', 'Safety'), ('CCTV', 'Safety'), ('Gated Community', 'Safety'),
  ('Power Backup', 'Utilities'), ('Rain Water Harvesting', 'Utilities'),
  ('Parking', 'Convenience'), ('Visitor Parking', 'Convenience'),
  ('Lift', 'Convenience'), ('Garden', 'Recreation'), ('Tennis Court', 'Recreation')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.lookup_location_advantages (name) VALUES
  ('Near Metro'), ('Near Hospital'), ('Near School'), ('Near Market'),
  ('Near Highway'), ('Near Park'), ('Near Mall'), ('Near Airport'),
  ('Main Road Facing'), ('Corner Plot')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.lookup_furnishing_items (name, category) VALUES
  ('AC', 'Electronics'), ('TV', 'Electronics'), ('Fridge', 'Electronics'),
  ('Washing Machine', 'Electronics'), ('Bed', 'Furniture'), ('Sofa', 'Furniture'),
  ('Dining Table', 'Furniture'), ('Wardrobe', 'Furniture'),
  ('Geyser', 'Electronics'), ('Microwave', 'Electronics')
ON CONFLICT (name) DO NOTHING;
