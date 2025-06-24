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
  
  const itemsPerPage = 12;

  const fetchProperties = useCallback(async (pageToFetch: number, shouldReset: boolean = false) => {
    setLoading(true);

    const { data, error } = await supabase.rpc('get_all_listings_paginated', {
        p_location_text: filters.location || null,
        p_bhk_type_id: filters.bhkTypeId ? Number(filters.bhkTypeId) : null,
        p_property_type_id: filters.propertyTypeId ? Number(filters.propertyTypeId) : null,
        p_sort_by: sort,
        p_page_num: pageToFetch,
        p_items_per_page: itemsPerPage,
    });
    
    if (error) {
      console.error('Error fetching properties:', error);
      setProperties([]);
      setHasMore(false);
    } else {
      const formattedData = (data || []) as PropertyCardProps['property'][];
      setProperties(shouldReset ? formattedData : prev => [...prev, ...formattedData]);
      setHasMore(formattedData.length === itemsPerPage);
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.location, filters.bhkTypeId, filters.propertyTypeId, sort]);

  // Effect to fetch on filter/sort change (resets properties)
  useEffect(() => {
    setPage(1); 
    fetchProperties(1, true); 
  }, [filters, sort, fetchProperties]);
  
  // Effect for infinite scroll (appends properties)
  const handleLoadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchProperties(nextPage, false);
  }

  // Effect to fetch dropdown data
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
        
        <div className="shadow-neumorphic-outset p-6 rounded-3xl mb-8 grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
            <div className="md:col-span-1">
                <label className="text-sm font-medium text-text-color-light mb-1 block">Location</label>
                <input type="text" name="location" placeholder="e.g., Mumbai, Bandra..." value={filters.location} onChange={(e) => setFilters(prev => ({...prev, location: e.target.value}))} className="neumorphic-input"/>
            </div>
            <div>
                <label className="text-sm font-medium text-text-color-light mb-1 block">Property Type</label>
                <select name="propertyTypeId" value={filters.propertyTypeId} onChange={(e) => setFilters(prev => ({...prev, propertyTypeId: e.target.value}))} className="neumorphic-input w-full"><option value="">Any Type</option>{propertyTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
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

        {loading && page === 1 ? (
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
                <button onClick={handleLoadMore} disabled={loading} className="neumorphic-button bg-cta-gradient w-48">
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
