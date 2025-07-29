-- supabase/migrations/20250726000001_create_get_project_by_slug_function.sql

CREATE OR REPLACE FUNCTION get_project_by_slug(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
SELECT jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'slug', p.slug,
    'low_price', p.low_price,
    'high_price', p.high_price,
    'description_html', p.description_html,
    'construction_phase', p.construction_phase,
    'delivery_date', p.delivery_date,
    'developer', (SELECT jsonb_build_object('name', d.name, 'logo', d.logo_storage_path) FROM public.developers d WHERE d.id = p.developer_id),
    -- FIX: Order the images array to ensure the primary image is always first.
    'images', (
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object('url', pi.storage_path_original, 'is_primary', pi.is_primary)
                ORDER BY pi.is_primary DESC, pi.id ASC -- Sort by primary flag, then by ID
            ),
            '[]'::jsonb
        )
        FROM public.project_images pi WHERE pi.project_id = p.id
    ),
    'amenities', (SELECT COALESCE(jsonb_agg(a.name), '[]'::jsonb) FROM public.project_amenities pa JOIN public.amenities a ON pa.amenity_id = a.id WHERE pa.project_id = p.id),
    'faqs', (SELECT COALESCE(jsonb_agg(jsonb_build_object('question', f.question, 'answer', f.answer)), '[]'::jsonb) FROM public.faqs f WHERE f.project_id = p.id),
    'unit_configurations', (SELECT COALESCE(jsonb_agg(uc.*), '[]'::jsonb) FROM public.unit_configurations uc WHERE uc.project_id = p.id),
    'latitude', p.latitude,
    'longitude', p.longitude
)
FROM public.projects p
WHERE p.slug = p_slug;
$$;