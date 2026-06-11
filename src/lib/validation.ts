import { z } from 'zod';

export const platformSettingsSchema = z.object({
  company_name: z.string().min(1).max(200),
  primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color'),
  secondary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color'),
  accent_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color'),
  logo_url: z.string().url().nullable().or(z.literal('')),
  logo_dark_url: z.string().url().nullable().or(z.literal('')),
  favicon_url: z.string().url().nullable().or(z.literal('')),
  contact_email: z.string().email().nullable().or(z.literal('')),
  contact_phone: z.string().nullable().or(z.literal('')),
  meta_title: z.string().max(200).nullable().or(z.literal('')),
  meta_description: z.string().max(500).nullable().or(z.literal('')),
  footer_text: z.string().max(500).nullable().or(z.literal('')),
});

export const leadSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().min(1, 'Phone is required').max(20),
  message: z.string().max(2000).optional().or(z.literal('')),
  property_id: z.string().uuid('Invalid property ID'),
});

export const propertyUpdateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional().or(z.literal('')),
  price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Invalid price'),
  location_text: z.string().min(1).max(500),
  listing_purpose_id: z.string().regex(/^\d+$/),
  ownership_type_id: z.string().regex(/^\d+$/),
  availability_status_id: z.string().regex(/^\d+$/),
  phone_number: z.string().min(1).max(20),
});

export const searchQuerySchema = z.object({
  query: z.string().max(500).optional(),
  location: z.string().max(500).optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  propertyType: z.string().max(50).optional(),
  bhkType: z.string().max(50).optional(),
  listingPurpose: z.string().max(50).optional(),
  amenities: z.array(z.string()).optional(),
  furnishings: z.array(z.string()).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().min(0).max(500).optional(),
  cursor: z.array(z.any()).optional(),
  pageSize: z.number().min(1).max(100).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'newest']).optional(),
});

export type PlatformSettingsInput = z.infer<typeof platformSettingsSchema>;
export type LeadInput = z.infer<typeof leadSchema>;
export type PropertyUpdateInput = z.infer<typeof propertyUpdateSchema>;
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
