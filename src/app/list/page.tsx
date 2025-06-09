// src/app/list/page.tsx
'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter, useSearchParams } from 'next/navigation';
import { FaMapMarkerAlt, FaSpinner } from 'react-icons/fa';
import Header from '@/app/components/Header';
import Link from 'next/link';

// --- Type Definitions ---
type Property = {
  id: string; title: string | null; price?: number | null; location_text: string | null;
  bhk_type: string | null; area_sqft: number | null; image_url: string | null;
};
type BhkType = { id: number; label: string; };
type PropertyType = { id: number; name: string; };
type SortOption = 'created_at' | 'price_asc' | 'price_desc';

// --- Main Component ---
export default function ListPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  
  // --- State for Filters, Sorting, and Pagination ---
  const [filters, setFilters] = useState({
    location: searchParams.get('location') || '',
    minPrice: '',
    maxPrice: '',
    bhkTypeId: '',
    propertyTypeId: '',
  });
  const [sort, setSort] = useState<SortOption>('created_at');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const [bhkTypes, setBhkTypes] = useState<BhkType[]>([]);
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([]);

  // --- Data Fetching Logic ---
  const fetchProperties = useCallback(async (pageToFetch: number) => {
    setLoading(true);
    const itemsPerPage = 12;
    const from = (pageToFetch - 1) * itemsPerPage;
    const to = from + itemsPerPage - 1;

    let query = supabase
      .from('properties')
      .select(`
        id, title, price, location_text, area_sqft,
        bhk_types ( label ),
        property_types ( name ),
        property_images ( image_url )
      `, { count: 'exact' });
    
    // Apply filters
    if (filters.location) query = query.ilike('location_text', `%${filters.location}%`);
    if (filters.minPrice) query = query.gte('price', filters.minPrice);
    if (filters.maxPrice) query = query.lte('price', filters.maxPrice);
    if (filters.bhkTypeId) query = query.eq('bhk_type_id', filters.bhkTypeId);
    if (filters.propertyTypeId) query = query.eq('property_type_id', filters.propertyTypeId);
    
    // Apply sorting
    if (sort === 'price_asc') query = query.order('price', { ascending: true });
    else if (sort === 'price_desc') query = query.order('price', { ascending: false });
    else query = query.order('created_at', { ascending: false });

    // Apply pagination
    query = query.range(from, to);

    const { data, error, count } = await query;
    
    if (error) {
      console.error('Error fetching properties:', error);
    } else {
      const formattedData = data.map(p => ({
        ...p,
        bhk_type: (p.bhk_types as any)?.label || 'N/A',
        property_type: (p.property_types as any)?.name || 'N/A',
        image_url: (p.property_images as any)?.[0]?.image_url || null,
      }));

      if (pageToFetch === 1) {
        setProperties(formattedData);
      } else {
        setProperties(prev => [...prev, ...formattedData]);
      }
      setHasMore((count || 0) > from + formattedData.length);
    }
    setLoading(false);
  }, [filters, sort]);

  // --- Initial data load and filter changes ---
  useEffect(() => {
    setPage(1); // Reset page to 1 when filters change
    fetchProperties(1);
  }, [filters, sort, fetchProperties]);

  // --- Infinite Scroll ---
  useEffect(() => {
    if (page > 1) {
      fetchProperties(page);
    }
  }, [page, fetchProperties]);
  
  // --- Handlers ---
  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };
  
  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSort(e.target.value as SortOption);
  }

  // Effect to load dropdown data
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
    <div className="flex flex-col min-h-screen bg-gray-50">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold text-gray-800 mb-6">Browse Properties</h1>
        
        {/* --- Filters & Sorting Bar --- */}
        <div className="bg-white p-4 rounded-lg shadow-sm mb-8 grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
          <div className="md:col-span-2">
            <label className="text-sm font-medium">Location</label>
            <input type="text" name="location" placeholder="e.g., Mumbai, Bandra..." value={filters.location} onChange={handleFilterChange} className="w-full mt-1 p-2 border rounded-md"/>
          </div>
          <div>
            <label className="text-sm font-medium">BHK Type</label>
            <select name="bhkTypeId" value={filters.bhkTypeId} onChange={handleFilterChange} className="w-full mt-1 p-2 border rounded-md bg-white"><option value="">Any</option>{bhkTypes.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
          </div>
          <div>
            <label className="text-sm font-medium">Property Type</label>
            <select name="propertyTypeId" value={filters.propertyTypeId} onChange={handleFilterChange} className="w-full mt-1 p-2 border rounded-md bg-white"><option value="">Any</option>{propertyTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </div>
          <div>
             <label className="text-sm font-medium">Sort By</label>
             <select value={sort} onChange={handleSortChange} className="w-full mt-1 p-2 border rounded-md bg-white">
                <option value="created_at">Newest</option>
                <option value="price_asc">Price: Low to High</option>
                <option value="price_desc">Price: High to Low</option>
             </select>
          </div>
        </div>

        {/* --- Property List --- */}
        {loading && properties.length === 0 ? (
          <div className="flex justify-center py-20"><FaSpinner className="animate-spin text-4xl text-blue-500" /></div>
        ) : properties.length > 0 ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {properties.map(property => (
                <div key={property.id} className="bg-white border rounded-lg shadow-sm hover:shadow-md transition-all cursor-pointer overflow-hidden flex flex-col">
                   <Link href={`/property/${property.id}`} className="block">
                        <div className="w-full h-48 bg-gray-200">
                            <img src={property.image_url || 'https://placehold.co/600x400/eee/ccc?text=No+Image'} alt={`Image of ${property.title}`} className="w-full h-full object-cover"/>
                        </div>
                        <div className="p-4 flex-grow flex flex-col">
                            <h3 className="font-bold text-lg truncate mb-1">{property.title}</h3>
                            <p className="text-sm text-gray-500 flex items-center gap-1 mb-2"><FaMapMarkerAlt size={12}/> {property.location_text}</p>
                            <div className="mt-auto">
                                <p className="text-xl text-green-700 font-semibold">₹{property.price?.toLocaleString() || 'N/A'}</p>
                                <p className="text-sm text-gray-600 mt-1">{property.area_sqft} sqft • {property.bhk_type}</p>
                            </div>
                        </div>
                   </Link>
                </div>
              ))}
            </div>
            {hasMore && (
              <div className="text-center mt-10">
                <button onClick={() => setPage(p => p + 1)} disabled={loading} className="bg-blue-600 text-white font-semibold py-2 px-6 rounded hover:bg-blue-700 disabled:bg-gray-400">
                  {loading ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-20">
            <h2 className="text-xl font-semibold text-gray-700">No Properties Found</h2>
            <p className="text-gray-500 mt-2">Try adjusting your filters to find what you're looking for.</p>
          </div>
        )}
      </div>
    </div>
  );
}
