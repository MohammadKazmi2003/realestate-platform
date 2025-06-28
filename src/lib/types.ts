// src/lib/types.ts
// This file defines the shape of our data for type safety and code completion across the app.

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

// This is the main, comprehensive data type for a single property,
// reflecting the nested structure of our database query.
export type PropertyDataType = {
  id: string;
  user_id: string;
  title: string;
  description: string;
  price: number;
  is_price_negotiable: boolean;
  location_text: string;
  created_at: string;
  profiles: {
    name: string | null;
    phone_number: string | null; // ADDED
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
    built_up_area: number | null; // PRESERVED
    super_built_up_area: number | null;
    bhk_types: BhkType | null;
    lookup_furnishing_statuses: { id: number; name: string } | null;
  }[] | null;

  details_commercial: {
    cabins: number | null;
    workstations: number | null; // PRESERVED
    meeting_rooms: number | null;
    private_washrooms: number | null;
    shared_washrooms: number | null; // PRESERVED
    passenger_lifts: number | null; // PRESERVED
    service_lifts: number | null; // PRESERVED
    is_pre_leased: boolean | null;
    has_noc: boolean | null;
    has_occupancy_cert: boolean | null;
    carpet_area: number | null; // PRESERVED
    lookup_commercial_sub_types: { id: number; name: string } | null;
    office_type: { id: number; name: string } | null; // PRESERVED
  }[] | null;
  
  details_land: { // ADDED
    plot_area: number | null;
    area_unit: string | null;
    is_boundary_wall_made: boolean | null;
  }[] | null;
  
  property_media: MediaItem[];
  lookup_amenities: LookupItem[];
  lookup_furnishing_items: LookupItem[];
  lookup_other_rooms: LookupItem[];
  lookup_location_advantages: LookupItem[];
};
