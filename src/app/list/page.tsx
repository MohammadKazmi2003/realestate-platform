'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Loader2 } from 'lucide-react';
import Header from '@/app/components/Header';
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard';

type BhkType = { id: number; label: string; };
type PropertyType = { id: number; name: string; };
type SortOption = 'created_at' | 'price_asc' | 'price_desc';

export default function ListPage() {
  const [properties, setProperties] = useState<PropertyCardProps['property'][]>([]);
  const [loading, setLoading] = useState(true);
  
  const [filters, setFilters] = useState({ location: '', bhkTypeId: '', propertyTypeId: '' });
  const [sort, setSort] = useState<SortOption>('created_at');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const [bhkTypes, setBhkTypes] = useState<BhkType[]>([]);
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([]);

  const fetchProperties = useCallback(async (pageToFetch: number) => {
    setLoading(true);
    const itemsPerPage = 12;
    const from = (pageToFetch - 1) * itemsPerPage;
    const to = from + itemsPerPage - 1;

    // This query now fetches all images for each property
    let query = supabase.from('properties').select(`
        id, title, price, location_text, area_sqft, user_id,
        bhk_types ( label ), 
        property_types ( name ),
        images:property_images ( image_url )
      `, { count: 'exact' });
    
    if (filters.location) query = query.ilike('location_text', `%${filters.location}%`);
    if (filters.bhkTypeId) query = query.eq('bhk_type_id', filters.bhkTypeId);
    if (filters.propertyTypeId) query = query.eq('property_type_id', filters.propertyTypeId);
    
    if (sort === 'price_asc') query = query.order('price', { ascending: true });
    else if (sort === 'price_desc') query = query.order('price', { ascending: false });
    else query = query.order('created_at', { ascending: false });

    query = query.range(from, to);

    const { data, error, count } = await query;
    
    if (error) {
      console.error('Error fetching properties:', error);
    } else {
      const formattedData = data.map(p => ({
        ...p,
        images: p.images || [],
      })) as PropertyCardProps['property'][];

      setProperties(pageToFetch === 1 ? formattedData : prev => [...prev, ...formattedData]);
      setHasMore((count || 0) > from + formattedData.length);
    }
    setLoading(false);
  }, [filters, sort]);

  useEffect(() => { setPage(1); fetchProperties(1); }, [filters, sort, fetchProperties]);
  useEffect(() => { if (page > 1) { fetchProperties(page); } }, [page]);
  
  useEffect(() => {
    const fetchDropdowns = async () => {
      const [bhkRes, propTypeRes] = await Promise.all([
        supabase.from('bhk_types').select('*'),
        supabase.from('property_types').select('*'),
      ]);
      setBhkTypes(bhkRes.data || []);
      setPropertyTypes(propTypeRes.data || []);
    };
    fetchDropdowns();
  }, []);

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-text-color-dark mb-6 text-center">Browse All Properties</h1>
        
        <div className="shadow-neumorphic-outset p-6 rounded-3xl mb-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-end">
            <div className="lg:col-span-2">
                <label className="text-sm font-medium text-text-color-light mb-1 block">Location</label>
                <input type="text" name="location" placeholder="e.g., Mumbai, Bandra..." value={filters.location} onChange={(e) => setFilters(prev => ({...prev, location: e.target.value}))} className="neumorphic-input"/>
            </div>
            <div>
                <label className="text-sm font-medium text-text-color-light mb-1 block">BHK Type</label>
                <select name="bhkTypeId" value={filters.bhkTypeId} onChange={(e) => setFilters(prev => ({...prev, bhkTypeId: e.target.value}))} className="neumorphic-input w-full"><option value="">Any</option>{bhkTypes.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
            </div>
            <div>
                <label className="text-sm font-medium text-text-color-light mb-1 block">Sort By</label>
                <select value={sort} onChange={(e) => setSort(e.target.value as SortOption)} className="neumorphic-input w-full">
                    <option value="created_at">Newest</option>
                    <option value="price_asc">Price: Low to High</option>
                    <option value="price_desc">Price: High to Low</option>
                </select>
            </div>
        </div>

        {loading && properties.length === 0 ? (
          <div className="flex justify-center py-20"><Loader2 className="animate-spin text-4xl text-text-color-light" /></div>
        ) : properties.length > 0 ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
              {properties.map(property => (
                <PropertyCard key={property.id} property={property} />
              ))}
            </div>
            {hasMore && (
              <div className="text-center mt-12">
                <button onClick={() => setPage(p => p + 1)} disabled={loading} className="neumorphic-button bg-cta-gradient w-48">
                  {loading ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-20">
            <h2 className="text-xl font-semibold text-text-color-dark">No Properties Found</h2>
            <p className="text-text-color-light mt-2">Try adjusting your filters to find what you're looking for.</p>
          </div>
        )}
      </div>
    </div>
  );
}
