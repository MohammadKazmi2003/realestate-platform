// src/lib/types.ts
// This file defines the shape of our data for type safety and code completion across the app.

export type MediaItem = {
  id: number;
  media_url: string;
  media_type: string;
  tag: string | null;
};

export type LookupItem = {
  name: string;
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
    phone_number: string | null;
  } | null;
  property_types: { name: string } | null;
  lookup_listing_purposes: { name: string } | null;
  lookup_availability_statuses: { name: string } | null;
  lookup_ownership_types: { name: string } | null;
  
  details_residential: {
    bathrooms: number | null;
    balconies: number | null;
    total_floors: number | null;
    property_on_floor: number | null;
    carpet_area: number | null;
    super_built_up_area: number | null;
    bhk_types: { label: string } | null;
    lookup_furnishing_statuses: { name: string } | null;
  }[] | null;

  details_commercial: {
    cabins: number | null;
    workstations: number | null;
    meeting_rooms: number | null;
    private_washrooms: number | null;
    is_pre_leased: boolean | null;
    has_noc: boolean | null;
    has_occupancy_cert: boolean | null;
    lookup_commercial_sub_types: { name: string } | null;
  }[] | null;
  
  property_media: MediaItem[];
  lookup_amenities: LookupItem[];
  lookup_furnishing_items: LookupItem[];
  lookup_other_rooms: LookupItem[];
  lookup_location_advantages: LookupItem[];
};
