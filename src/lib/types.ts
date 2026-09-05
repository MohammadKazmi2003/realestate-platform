// src/lib/types.ts
export type MediaItem = {
  id: number;
  media_url: string;
  media_type: string;
  tag: string | null;
};

export type LookupItem = {
  id: number;
  name: string;
};

export type BhkType = {
  id: number;
  label: string;
};

export type User = {
  id: string;
  email?: string;
  role?: string;
};

export type PropertyDataType = {
  id: string;
  user_id: string;
  title: string;
  description: string;
  price: number;
  is_price_negotiable: boolean;
  location_text: string;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  profiles: {
    name: string | null;
    phone_number: string | null;
    role_id: number;
  } | null;
  property_types: { id: number; name: string } | null;
  lookup_listing_purposes: { id: number; name: string } | null;
  lookup_availability_statuses: { id: number; name: string } | null;
  lookup_ownership_types: { id: number; name: string } | null;
  
  details_residential: {
    bathrooms: number | null;
    balconies: number | null;
    total_floors: number | null;
    property_on_floor: number | null;
    carpet_area: number | null;
    built_up_area: number | null;
    super_built_up_area: number | null;
    bhk_types: BhkType | null;
    lookup_furnishing_statuses: { id: number; name: string } | null;
  }[] | null;

  details_commercial: {
    cabins: number | null;
    workstations: number | null;
    min_seats: number | null;
    max_seats: number | null;
    total_floors: number | null;
    property_on_floor: number | null;
    meeting_rooms: number | null;
    private_washrooms: number | null;
    shared_washrooms: number | null;
    passenger_lifts: number | null;
    service_lifts: number | null;
    is_pre_leased: boolean | null;
    has_noc: boolean | null;
    has_occupancy_cert: boolean | null;
    carpet_area: number | null;
    lookup_commercial_sub_types: { id: number; name: string } | null;
    office_type: { id: number; name: string } | null;
    lookup_furnishing_statuses: { id: number; name: string } | null;
  }[] | null;
  
  details_land: {
    plot_area: number | null;
    area_unit: string | null;
    is_boundary_wall_made: boolean | null;
  }[] | null;
  
  property_media: MediaItem[];
  lookup_amenities: LookupItem[];
  lookup_furnishing_items: LookupItem[];
  lookup_other_rooms: LookupItem[];
  lookup_location_advantages: LookupItem[];
  // *** FIX: Added the missing lookup_land_features property ***
  lookup_land_features: LookupItem[];
};

export type Project = {
  id: string;
  name: string;
  slug: string;
  low_price: number;
  high_price: number;
  construction_phase: string;
  construction_progress_percent?: number | null;
  delivery_date: string | null;
  developer_name: string;
  primary_image: string | null;
  location_name: string | null;
  bedrooms_list?: number[] | null;
  unit_count?: number | null;
  payment_plan_summary?: string | null;
  amenities?: string[] | null;
  amenities_total?: number | null;
  total_count?: number;
};

export type ProjectDetails = {
  id: string;
  type: string;
  title: string;
  description: string;
  description_html: string;
  price_range: { low: number; high: number; currency: string } | null;
  location_text: string | null;
  latitude: number | null;
  longitude: number | null;
  developer: { name: string; logo: string | null } | null;
  status: { phase: string; progress_percent: number | null; delivery_date: string | null } | null;
  property_types: string[];
  project_media: { id: string; storage_path_original: string; is_primary: boolean }[];
  project_videos: { video_storage_path: string; thumbnail_storage_path: string | null }[] | null;
  unit_configurations: {
    id: string;
    property_type: string;
    bedrooms: number | null;
    area_from_sqft: number | null;
    area_to_sqft: number | null;
    starting_price: number | null;
    floor_plan_urls: string[] | null;
  }[];
  amenities: { id: string; name: string }[];
  faqs: { id: string; question: string; answer: string }[];
  master_plan_description: string | null;
  master_plan_storage_path: string | null;
  brochure_storage_path: string | null;
};
