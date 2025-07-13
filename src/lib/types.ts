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
