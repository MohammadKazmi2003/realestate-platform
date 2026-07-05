'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Loader2, Search, SlidersHorizontal, X, ChevronDown, ChevronUp } from 'lucide-react';
import Header from '@/app/components/Header';
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard';
import { searchProperties, mapEsResultToPropertyCard } from '@/lib/searchClient';
import { getLookup } from '@/lib/lookupCache';

type BhkType = { id: number; label: string; };
type PropertyType = { id: number; name: string; };
type ListingPurpose = { id: number; name: string; };
type FurnishingStatus = { id: number; name: string; };
type Amenity = { id: number; name: string; category?: string; };
type SortOption = 'relevance' | 'popular' | 'newest' | 'price_asc' | 'price_desc';

const BATHROOM_OPTIONS = [1, 2, 3, 4, 5, 6];
const INITIAL_AMENITIES_COUNT = 8;

const FURNISHING_NORMALIZE: Record<string, string> = {
  'Furnished': 'Fully Furnished',
  'Fully Furnished': 'Fully Furnished',
  'Semi-furnished': 'Semi Furnished',
  'Semi Furnished': 'Semi Furnished',
  'Un-furnished': 'Unfurnished',
  'Unfurnished': 'Unfurnished',
};

type Filters = {
  location: string;
  propertyTypeId: string;
  bhkTypeId: string;
  listingPurposeId: string;
  minPrice: string;
  maxPrice: string;
  minArea: string;
  maxArea: string;
  bathrooms: string;
  furnishingStatusIds: string[];
  amenityIds: string[];
};

type LookupMaps = {
  bhkIdToLabel: Record<number, string>;
  propTypeIdToName: Record<number, string>;
  listingPurposeIdToName: Record<number, string>;
  furnishingStatusIdToName: Record<number, string>;
  amenityIdToName: Record<number, string>;
};

type FilterSectionProps = {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

const FilterSection = ({ label, defaultOpen = true, children }: FilterSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full text-left mb-2 group"
      >
        <label className="font-semibold text-text-color-dark cursor-pointer group-hover:text-blue-600 transition-colors">
          {label}
        </label>
        {open ? <ChevronUp size={16} className="text-text-color-light" /> : <ChevronDown size={16} className="text-text-color-light" />}
      </button>
      {open && <div className="space-y-2">{children}</div>}
    </div>
  );
};

type FilterSidebarProps = {
  isOpen: boolean;
  onClose: () => void;
  filters: Filters;
  propertyTypes: PropertyType[];
  bhkTypes: BhkType[];
  listingPurposes: ListingPurpose[];
  furnishingStatuses: FurnishingStatus[];
  allAmenities: Amenity[];
  onFilterChange: (key: keyof Filters, value: any) => void;
  onClearFilters: () => void;
  amenitySearchTerm: string;
  onAmenitySearchChange: (term: string) => void;
  showAllAmenities: boolean;
  onToggleShowAllAmenities: () => void;
};

const FilterSidebar = ({
  isOpen, onClose, filters, propertyTypes, bhkTypes, listingPurposes,
  furnishingStatuses, allAmenities, onFilterChange, onClearFilters,
  amenitySearchTerm, onAmenitySearchChange, showAllAmenities, onToggleShowAllAmenities,
}: FilterSidebarProps) => {
  const filteredAmenities = useMemo(() =>
    allAmenities.filter(a =>
      a.name.toLowerCase().includes(amenitySearchTerm.toLowerCase())
    ),
    [allAmenities, amenitySearchTerm]
  );
  const displayedAmenities = showAllAmenities ? filteredAmenities : filteredAmenities.slice(0, INITIAL_AMENITIES_COUNT);

  const furnishingGroups = useMemo(() => {
    const map = new Map<string, { ids: string[]; name: string }>();
    furnishingStatuses.forEach(fs => {
      const key = FURNISHING_NORMALIZE[fs.name] || fs.name;
      if (!map.has(key)) {
        map.set(key, { ids: [], name: key });
      }
      map.get(key)!.ids.push(String(fs.id));
    });
    return Array.from(map.values());
  }, [furnishingStatuses]);

  const isFurnishingActive = (ids: string[]) =>
    ids.some(id => filters.furnishingStatusIds.includes(id));

  const toggleFurnishingGroup = (ids: string[]) => {
    const allActive = ids.every(id => filters.furnishingStatusIds.includes(id));
    onFilterChange(
      'furnishingStatusIds',
      allActive
        ? filters.furnishingStatusIds.filter(i => !ids.includes(i))
        : [...filters.furnishingStatusIds, ...ids.filter(i => !filters.furnishingStatusIds.includes(i))]
    );
  };

  return (
    <aside className={`fixed top-0 right-0 h-full w-[28rem] max-w-[90vw] bg-bg-color shadow-2xl p-6 z-50 transform transition-transform overflow-y-auto ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
      <div className="flex justify-between items-center mb-6 sticky top-0 bg-bg-color pb-3 border-b border-shadow-dark/10">
        <h2 className="text-xl font-bold text-text-color-dark">Filters</h2>
        <button onClick={onClose} className="neumorphic-button !p-2 !rounded-full"><X size={20} /></button>
      </div>
      <div className="space-y-5">
        <div>
          <label className="font-semibold block mb-2 text-text-color-dark">Location</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-color-light" size={18} />
            <input
              type="text" placeholder="City, locality..." value={filters.location}
              onChange={e => onFilterChange('location', e.target.value)}
              className="neumorphic-input w-full !pl-10"
            />
          </div>
        </div>

        <FilterSection label="Property Details">
          <div>
            <label className="text-sm text-text-color-light block mb-1">Property Type</label>
            <select value={filters.propertyTypeId} onChange={e => onFilterChange('propertyTypeId', e.target.value)} className="neumorphic-input w-full">
              <option value="">Any Type</option>
              {propertyTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-sm text-text-color-light block mb-1">BHK</label>
              <select value={filters.bhkTypeId} onChange={e => onFilterChange('bhkTypeId', e.target.value)} className="neumorphic-input w-full">
                <option value="">Any BHK</option>
                {bhkTypes.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm text-text-color-light block mb-1">Listing Purpose</label>
              <select value={filters.listingPurposeId} onChange={e => onFilterChange('listingPurposeId', e.target.value)} className="neumorphic-input w-full">
                <option value="">Any</option>
                {listingPurposes.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>
        </FilterSection>

        <FilterSection label="Price & Area">
          <div>
            <label className="text-sm text-text-color-light block mb-1">Price Range (₹)</label>
            <div className="flex gap-2">
              <input type="number" placeholder="Min" value={filters.minPrice} onChange={e => onFilterChange('minPrice', e.target.value)} className="neumorphic-input w-full" />
              <span className="text-text-color-light self-center">-</span>
              <input type="number" placeholder="Max" value={filters.maxPrice} onChange={e => onFilterChange('maxPrice', e.target.value)} className="neumorphic-input w-full" />
            </div>
          </div>
          <div>
            <label className="text-sm text-text-color-light block mb-1">Carpet Area (sqft)</label>
            <div className="flex gap-2">
              <input type="number" placeholder="Min" value={filters.minArea} onChange={e => onFilterChange('minArea', e.target.value)} className="neumorphic-input w-full" />
              <span className="text-text-color-light self-center">-</span>
              <input type="number" placeholder="Max" value={filters.maxArea} onChange={e => onFilterChange('maxArea', e.target.value)} className="neumorphic-input w-full" />
            </div>
          </div>
        </FilterSection>

        <FilterSection label="Room Details">
          <div>
            <label className="text-sm text-text-color-light block mb-1">Bathrooms</label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => onFilterChange('bathrooms', '')}
                className={`neumorphic-button !text-sm ${!filters.bathrooms ? 'shadow-neumorphic-inset' : ''}`}
              >
                Any
              </button>
              {BATHROOM_OPTIONS.map(n => (
                <button
                  key={n}
                  onClick={() => onFilterChange('bathrooms', String(filters.bathrooms === String(n) ? '' : n))}
                  className={`neumorphic-button !text-sm ${filters.bathrooms === String(n) ? 'shadow-neumorphic-inset' : ''}`}
                >
                  {n}+
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm text-text-color-light block mb-1">Furnishing</label>
            <div className="flex flex-wrap gap-2">
              {furnishingGroups.map(group => (
                <button
                  key={group.name}
                  onClick={() => toggleFurnishingGroup(group.ids)}
                  className={`neumorphic-button !text-sm ${isFurnishingActive(group.ids) ? 'shadow-neumorphic-inset' : ''}`}
                >
                  {group.name}
                </button>
              ))}
            </div>
          </div>
        </FilterSection>

        <FilterSection label="Amenities">
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-color-light" size={18} />
            <input
              type="text" placeholder="Search amenities..."
              value={amenitySearchTerm}
              onChange={e => onAmenitySearchChange(e.target.value)}
              className="neumorphic-input w-full !pl-10"
            />
          </div>
          <div className="max-h-[200px] overflow-y-auto rounded-lg p-1">
            <div className="flex flex-wrap gap-2">
              {displayedAmenities.map(a => (
                <button
                  key={a.id}
                  onClick={() => onFilterChange(
                    'amenityIds',
                    filters.amenityIds.includes(String(a.id))
                      ? filters.amenityIds.filter(i => i !== String(a.id))
                      : [...filters.amenityIds, String(a.id)]
                  )}
                  className={`neumorphic-button !text-sm ${filters.amenityIds.includes(String(a.id)) ? 'shadow-neumorphic-inset' : ''}`}
                >
                  {a.name}
                </button>
              ))}
            </div>
          </div>
          {filteredAmenities.length > INITIAL_AMENITIES_COUNT && (
            <button onClick={onToggleShowAllAmenities} className="text-blue-600 text-sm font-semibold mt-2 hover:underline">
              {showAllAmenities ? 'View less' : `View more (${filteredAmenities.length - INITIAL_AMENITIES_COUNT} more)`}
            </button>
          )}
        </FilterSection>

        <button onClick={onClearFilters} className="w-full neumorphic-button !bg-danger-color/20 mt-4 shrink-0">
          Clear All Filters
        </button>
      </div>
    </aside>
  );
};

export default function ListPage() {
  const [properties, setProperties] = useState<PropertyCardProps['property'][]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);

  const [filters, setFilters] = useState<Filters>({
    location: '',
    propertyTypeId: '',
    bhkTypeId: '',
    listingPurposeId: '',
    minPrice: '',
    maxPrice: '',
    minArea: '',
    maxArea: '',
    bathrooms: '',
    furnishingStatusIds: [],
    amenityIds: [],
  });
  const [sort, setSort] = useState<SortOption>('relevance');
  const [nextCursor, setNextCursor] = useState<any[] | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const [bhkTypes, setBhkTypes] = useState<BhkType[]>([]);
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([]);
  const [listingPurposes, setListingPurposes] = useState<ListingPurpose[]>([]);
  const [furnishingStatuses, setFurnishingStatuses] = useState<FurnishingStatus[]>([]);
  const [allAmenities, setAllAmenities] = useState<Amenity[]>([]);
  const [lookupMaps, setLookupMaps] = useState<LookupMaps>({
    bhkIdToLabel: {},
    propTypeIdToName: {},
    listingPurposeIdToName: {},
    furnishingStatusIdToName: {},
    amenityIdToName: {},
  });

  const [amenitySearchTerm, setAmenitySearchTerm] = useState('');
  const [showAllAmenities, setShowAllAmenities] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const itemsPerPage = 12;

  const buildSearchParams = useCallback(() => {
    const { bhkIdToLabel, propTypeIdToName, listingPurposeIdToName, furnishingStatusIdToName, amenityIdToName } = lookupMaps;
    const params: any = { pageSize: itemsPerPage, sort };

    if (filters.location) params.location = filters.location;
    if (filters.propertyTypeId && propTypeIdToName[Number(filters.propertyTypeId)]) {
      params.propertyType = propTypeIdToName[Number(filters.propertyTypeId)];
    }
    if (filters.bhkTypeId && bhkIdToLabel[Number(filters.bhkTypeId)]) {
      params.bhkType = bhkIdToLabel[Number(filters.bhkTypeId)];
    }
    if (filters.listingPurposeId && listingPurposeIdToName[Number(filters.listingPurposeId)]) {
      params.listingPurpose = listingPurposeIdToName[Number(filters.listingPurposeId)];
    }
    if (filters.minPrice) params.minPrice = Number(filters.minPrice);
    if (filters.maxPrice) params.maxPrice = Number(filters.maxPrice);
    if (filters.minArea) params.minArea = Number(filters.minArea);
    if (filters.maxArea) params.maxArea = Number(filters.maxArea);
    if (filters.bathrooms) params.bathrooms = Number(filters.bathrooms);
    if (filters.furnishingStatusIds.length > 0) {
      params.furnishings = filters.furnishingStatusIds
        .map(id => furnishingStatusIdToName[Number(id)])
        .filter(Boolean);
    }
    if (filters.amenityIds.length > 0) {
      params.amenities = filters.amenityIds
        .map(id => amenityIdToName[Number(id)])
        .filter(Boolean);
    }
    return params;
  }, [filters, sort, lookupMaps]);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fetchPropertiesRef = useRef<typeof fetchPropertiesImpl>(() => Promise.resolve());
  const buildSearchParamsRef = useRef(buildSearchParams);
  const fetchIdRef = useRef(0);
  buildSearchParamsRef.current = buildSearchParams;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetchPropertiesImpl = useCallback(async (cursor: any[] | null, shouldReset: boolean = false) => {
    const fetchId = ++fetchIdRef.current;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setLoading(true);
    const params = buildSearchParamsRef.current();
    if (cursor) params.cursor = cursor;

    try {
      const response = await searchProperties(params, signal);
      if (fetchId !== fetchIdRef.current) return;
      if (!response || !response.results) {
        setProperties([]);
        setHasMore(false);
        setTotalCount(0);
      } else {
        const mapped = response.results.map((r: any) => mapEsResultToPropertyCard(r));
        setProperties(shouldReset ? mapped : prev => [...prev, ...mapped]);
        setNextCursor(response.nextCursor);
        setHasMore(!!response.nextCursor);
        setTotalCount(response.total || 0);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (fetchId !== fetchIdRef.current) return;
      console.error('Error fetching properties:', err);
      setProperties([]);
      setHasMore(false);
      setTotalCount(0);
    }
    if (fetchId === fetchIdRef.current) setLoading(false);
  }, []);

  fetchPropertiesRef.current = fetchPropertiesImpl;

  const debouncedFetchProperties = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setNextCursor(null);
      (fetchPropertiesRef.current as any)(null, true);
    }, 500);
  }, []);

  useEffect(() => {
    setNextCursor(null);
    fetchPropertiesImpl(null, true);
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && hasMore && nextCursor) {
          fetchPropertiesImpl(nextCursor, false);
        }
      },
      { rootMargin: '400px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, nextCursor, fetchPropertiesImpl]);

  useEffect(() => {
    const fetchDropdowns = async () => {
      const [bhkData, propTypeData, listingPurposeData, furnishingData, amenityData] = await Promise.all([
        getLookup('bhk_types'),
        getLookup('property_types'),
        getLookup('lookup_listing_purposes'),
        getLookup('lookup_furnishing_statuses'),
        getLookup('lookup_amenities'),
      ]);
      setBhkTypes(bhkData);
      setPropertyTypes(propTypeData);
      setListingPurposes(listingPurposeData);
      setFurnishingStatuses(furnishingData);
      setAllAmenities(amenityData);
      setLookupMaps({
        bhkIdToLabel: Object.fromEntries(bhkData.map((b: any) => [b.id, b.label])),
        propTypeIdToName: Object.fromEntries(propTypeData.map((p: any) => [p.id, p.name])),
        listingPurposeIdToName: Object.fromEntries(listingPurposeData.map((l: any) => [l.id, l.name])),
        furnishingStatusIdToName: Object.fromEntries(furnishingData.map((f: any) => [f.id, f.name])),
        amenityIdToName: Object.fromEntries(amenityData.map((a: any) => [a.id, a.name])),
      });
    };
    fetchDropdowns();
  }, []);

  const handleFilterChange = (key: keyof Filters, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    debouncedFetchProperties();
  };

  const handleSortChange = (value: SortOption) => {
    setSort(value);
    debouncedFetchProperties();
  };

  const clearFilters = () => {
    setFilters({
      location: '',
      propertyTypeId: '',
      bhkTypeId: '',
      listingPurposeId: '',
      minPrice: '',
      maxPrice: '',
      minArea: '',
      maxArea: '',
      bathrooms: '',
      furnishingStatusIds: [],
      amenityIds: [],
    });
    setSort('relevance');
    setAmenitySearchTerm('');
    setShowAllAmenities(false);
    debouncedFetchProperties();
  };

  const activeFilterCount =
    (filters.location ? 1 : 0) +
    (filters.propertyTypeId ? 1 : 0) +
    (filters.bhkTypeId ? 1 : 0) +
    (filters.listingPurposeId ? 1 : 0) +
    (filters.minPrice ? 1 : 0) +
    (filters.maxPrice ? 1 : 0) +
    (filters.minArea ? 1 : 0) +
    (filters.maxArea ? 1 : 0) +
    (filters.bathrooms ? 1 : 0) +
    filters.furnishingStatusIds.length +
    filters.amenityIds.length;

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-4 sm:p-6 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-4 text-center text-text-color-dark">Browse All Properties</h1>
        <p className="text-center text-text-color-light mb-8 min-h-[1.5rem]">{totalCount > 0 ? `${totalCount} properties found` : ''}</p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-8 shadow-neumorphic-outset p-3 rounded-3xl">
          <div className="relative sm:max-w-sm md:max-w-md lg:max-w-lg flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-color-light pointer-events-none" size={18} />
            <input
              type="text"
              placeholder="Search by location..."
              value={filters.location}
              onChange={e => handleFilterChange('location', e.target.value)}
              className="w-full !pl-10 !pr-4 neumorphic-input"
            />
          </div>
          <div className="flex items-center gap-2 sm:ml-auto">
            <select
              value={sort}
              onChange={e => handleSortChange(e.target.value as SortOption)}
              className="neumorphic-input !w-auto !min-w-[140px]"
            >
              <option value="relevance">Relevance</option>
              <option value="popular">Most Popular</option>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: Low → High</option>
              <option value="price_desc">Price: High → Low</option>
            </select>
            <button onClick={() => setIsFilterOpen(true)} className="neumorphic-button flex items-center gap-2 relative whitespace-nowrap">
              <SlidersHorizontal size={16} /> Filters
              {activeFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </button>
          </div>
        </div>

        <FilterSidebar
          isOpen={isFilterOpen}
          onClose={() => setIsFilterOpen(false)}
          filters={filters}
          propertyTypes={propertyTypes}
          bhkTypes={bhkTypes}
          listingPurposes={listingPurposes}
          furnishingStatuses={furnishingStatuses}
          allAmenities={allAmenities}
          onFilterChange={handleFilterChange}
          onClearFilters={clearFilters}
          amenitySearchTerm={amenitySearchTerm}
          onAmenitySearchChange={setAmenitySearchTerm}
          showAllAmenities={showAllAmenities}
          onToggleShowAllAmenities={() => setShowAllAmenities(prev => !prev)}
        />
        {isFilterOpen && <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setIsFilterOpen(false)} />}

        {loading && !properties.length ? (
          <div className="flex justify-center py-20"><Loader2 className="animate-spin h-12 w-12 text-text-color-light" /></div>
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
                  <Loader2 className="animate-spin h-8 w-8 text-text-color-light mx-auto" />
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
      </main>
    </div>
  );
}
