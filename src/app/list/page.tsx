'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Loader2 } from 'lucide-react';
import Header from '@/app/components/Header';
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard';
import { searchProperties, mapEsResultToPropertyCard } from '@/lib/searchClient';

type BhkType = { id: number; label: string; };
type PropertyType = { id: number; name: string; };
type SortOption = 'created_at' | 'price_asc' | 'price_desc';

export default function ListPage() {
  const [properties, setProperties] = useState<PropertyCardProps['property'][]>([]);
  const [loading, setLoading] = useState(true);
  
  const [filters, setFilters] = useState({ location: '', bhkTypeId: '', propertyTypeId: '' });
  const [sort, setSort] = useState<SortOption>('created_at');
  const [nextCursor, setNextCursor] = useState<any[] | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const [bhkTypes, setBhkTypes] = useState<BhkType[]>([]);
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([]);
  const [lookupMaps, setLookupMaps] = useState<{
    bhkIdToLabel: Record<number, string>;
    propTypeIdToName: Record<number, string>;
  }>({ bhkIdToLabel: {}, propTypeIdToName: {} });
  
  const sentinelRef = useRef<HTMLDivElement>(null);
  const itemsPerPage = 12;

  const fetchProperties = useCallback(async (cursor: any[] | null, shouldReset: boolean = false) => {
    setLoading(true);
    const { bhkIdToLabel, propTypeIdToName } = lookupMaps;

    const params: any = { pageSize: itemsPerPage };
    if (filters.location) params.location = filters.location;
    if (filters.bhkTypeId && bhkIdToLabel[Number(filters.bhkTypeId)]) {
      params.bhkType = bhkIdToLabel[Number(filters.bhkTypeId)];
    }
    if (filters.propertyTypeId && propTypeIdToName[Number(filters.propertyTypeId)]) {
      params.propertyType = propTypeIdToName[Number(filters.propertyTypeId)];
    }

    const sortMap: Record<string, string> = {
      created_at: 'newest',
      price_asc: 'price_asc',
      price_desc: 'price_desc',
    };
    params.sort = sortMap[sort] || 'newest';

    if (cursor) params.cursor = cursor;

    try {
      const response = await searchProperties(params);
      if (!response || !response.results) {
        setProperties([]);
        setHasMore(false);
      } else {
        const mapped = response.results.map((r: any) => mapEsResultToPropertyCard(r));
        setProperties(shouldReset ? mapped : prev => [...prev, ...mapped]);
        setNextCursor(response.nextCursor);
        setHasMore(!!response.nextCursor);
      }
    } catch (err) {
      console.error('Error fetching properties:', err);
      setProperties([]);
      setHasMore(false);
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.location, filters.bhkTypeId, filters.propertyTypeId, sort, lookupMaps]);

  // Effect to fetch on filter/sort change (resets properties)
  useEffect(() => {
    setNextCursor(null);
    fetchProperties(null, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sort]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && hasMore && nextCursor) {
          fetchProperties(nextCursor, false);
        }
      },
      { rootMargin: '400px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, nextCursor, fetchProperties]);

  // Effect to fetch dropdown data and build lookup maps
  useEffect(() => {
    const fetchDropdowns = async () => {
      const [bhkRes, propTypeRes] = await Promise.all([
        supabase.from('bhk_types').select('*'),
        supabase.from('property_types').select('*'),
      ]);
      const bhkData = bhkRes.data || [];
      const propTypeData = propTypeRes.data || [];
      setBhkTypes(bhkData);
      setPropertyTypes(propTypeData);
      setLookupMaps({
        bhkIdToLabel: Object.fromEntries(bhkData.map((b: any) => [b.id, b.label])),
        propTypeIdToName: Object.fromEntries(propTypeData.map((p: any) => [p.id, p.name])),
      });
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

        {loading && !properties.length ? (
          <div className="flex justify-center py-20"><Loader2 className="animate-spin text-4xl text-text-color-light" /></div>
        ) : properties.length > 0 ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
              {properties.map(property => (
                <div key={property.id} style={{ contentVisibility: 'auto' }}>
                  <PropertyCard property={property} />
                </div>
              ))}
            </div>
            {hasMore && (
              <div className="text-center mt-12">
                {loading ? (
                  <Loader2 className="animate-spin text-3xl text-text-color-light mx-auto" />
                ) : (
                  <div ref={sentinelRef} className="h-4" />
                )}
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
