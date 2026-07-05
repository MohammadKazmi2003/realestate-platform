'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { getLookup, getCachedRpc } from '@/lib/lookupCache';
import Header from '@/app/components/Header';
import { ProjectCard } from '@/app/components/ProjectCard';
import { Loader2, X, Search, SlidersHorizontal } from 'lucide-react';
import { Project } from '@/lib/types';

type Filters = {
  searchText: string;
  completionStatus: string[];
  bedrooms: number[];
  minPrice: string;
  maxPrice: string;
  amenityIds: string[];
};

type LookupData = {
  amenities: { id: string; name: string }[];
  completionStatuses: string[];
};

const BEDROOM_OPTIONS = [0, 1, 2, 3, 4, 5];
const INITIAL_AMENITIES_COUNT = 8;

type FilterSidebarProps = {
  isOpen: boolean;
  onClose: () => void;
  filters: Filters;
  lookupData: LookupData;
  onFilterChange: (filterName: keyof Filters, value: any) => void;
  onClearFilters: () => void;
  amenitySearchTerm: string;
  onAmenitySearchChange: (term: string) => void;
  showAllAmenities: boolean;
  onToggleShowAllAmenities: () => void;
};

const FilterSidebar = ({
  isOpen, onClose, filters, lookupData, onFilterChange, onClearFilters,
  amenitySearchTerm, onAmenitySearchChange, showAllAmenities, onToggleShowAllAmenities
}: FilterSidebarProps) => {
  const filteredAmenities = useMemo(() =>
    lookupData.amenities.filter(a =>
      a.name.toLowerCase().includes(amenitySearchTerm.toLowerCase())
    ),
    [lookupData.amenities, amenitySearchTerm]
  );

  const displayedAmenities = showAllAmenities ? filteredAmenities : filteredAmenities.slice(0, INITIAL_AMENITIES_COUNT);

  return (
    <aside className={`fixed top-0 right-0 h-full w-80 bg-bg-color shadow-neumorphic-outset p-6 z-50 transform transition-transform ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-text-color-dark">Filters</h2>
        <button onClick={onClose} className="neumorphic-button !p-2 !rounded-full"><X size={20} /></button>
      </div>
      <div className="space-y-6 overflow-y-auto h-[calc(100%-80px)] pr-2">
        <div>
          <label className="font-semibold block mb-2 text-text-color-dark">Bedrooms</label>
          <div className="flex flex-wrap gap-2">
            {BEDROOM_OPTIONS.map(bed => (
              <button
                key={bed}
                onClick={() => onFilterChange('bedrooms', bed)}
                className={`neumorphic-button !text-sm ${filters.bedrooms.includes(bed) ? 'shadow-neumorphic-inset' : ''}`}
              >
                {bed === 0 ? 'Studio' : `${bed} Bed`}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="font-semibold block mb-2 text-text-color-dark">Price Range (AED)</label>
          <div className="flex gap-2">
            <input type="number" placeholder="Min" value={filters.minPrice} onChange={e => onFilterChange('minPrice', e.target.value)} className="neumorphic-input w-full" />
            <input type="number" placeholder="Max" value={filters.maxPrice} onChange={e => onFilterChange('maxPrice', e.target.value)} className="neumorphic-input w-full" />
          </div>
        </div>
        <div>
          <label className="font-semibold block mb-2 text-text-color-dark">Completion Status</label>
          <div className="flex flex-wrap gap-2">
            {lookupData.completionStatuses.map(status => (
              <button
                key={status}
                onClick={() => onFilterChange('completionStatus', status)}
                className={`neumorphic-button !text-sm capitalize ${filters.completionStatus.includes(status) ? 'shadow-neumorphic-inset' : ''}`}
              >
                {status.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="font-semibold block mb-2 text-text-color-dark">Amenities</label>
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-color-light" size={18} />
            <input
              type="text"
              placeholder="Search amenities..."
              value={amenitySearchTerm}
              onChange={e => onAmenitySearchChange(e.target.value)}
              className="neumorphic-input w-full !pl-10"
            />
          </div>
          <div className="max-h-[180px] overflow-y-auto rounded-lg p-1">
            <div className="flex flex-wrap gap-2">
              {displayedAmenities.map(amenity => (
                <button
                  key={amenity.id}
                  onClick={() => onFilterChange('amenityIds', amenity.id)}
                  className={`neumorphic-button !text-sm ${filters.amenityIds.includes(amenity.id) ? 'shadow-neumorphic-inset' : ''}`}
                >
                  {amenity.name}
                </button>
              ))}
            </div>
          </div>
          {filteredAmenities.length > INITIAL_AMENITIES_COUNT && (
            <button onClick={onToggleShowAllAmenities} className="text-blue-600 text-sm font-semibold mt-2 hover:underline">
              {showAllAmenities ? 'View less' : `View more (${filteredAmenities.length - INITIAL_AMENITIES_COUNT} more)`}
            </button>
          )}
        </div>
        <button onClick={onClearFilters} className="w-full neumorphic-button !bg-danger-color/20 mt-4 shrink-0">Clear All Filters</button>
      </div>
    </aside>
  );
};

type PaginationProps = {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
};

const Pagination = ({ currentPage, totalPages, onPageChange }: PaginationProps) => (
  <div className="flex justify-center items-center gap-4 mt-8">
    <button onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 1} className="neumorphic-button disabled:opacity-50">Previous</button>
    <span className="text-text-color-light">Page {currentPage} of {totalPages}</span>
    <button onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages} className="neumorphic-button disabled:opacity-50">Next</button>
  </div>
);

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const cursorRef = useRef<Record<number, any>>({});
  const ITEMS_PER_PAGE = 12;

  const [sortBy, setSortBy] = useState('created_at_desc');
  const [filters, setFilters] = useState<Filters>({
    searchText: '',
    completionStatus: [],
    bedrooms: [],
    minPrice: '',
    maxPrice: '',
    amenityIds: [],
  });
  const [lookupData, setLookupData] = useState<LookupData>({ amenities: [], completionStatuses: [] });
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [amenitySearchTerm, setAmenitySearchTerm] = useState('');
  const [showAllAmenities, setShowAllAmenities] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fetchProjectsRef = useRef<typeof fetchProjectsImpl>(() => Promise.resolve());
  const currentPageRef = useRef(currentPage);
  const sortByRef = useRef(sortBy);
  const filtersRef = useRef(filters);
  const fetchIdRef = useRef(0);

  currentPageRef.current = currentPage;
  sortByRef.current = sortBy;
  filtersRef.current = filters;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetchProjectsImpl = useCallback(async (pageOverride?: number, filterOverride?: Filters, sortOverride?: string) => {
    const fetchId = ++fetchIdRef.current;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setLoading(true);
    setError(null);

    const page = pageOverride ?? currentPageRef.current;
    const activeFilters = filterOverride ?? filtersRef.current;
    const activeSort = sortOverride ?? sortByRef.current;

    const cursor = page > 1 ? cursorRef.current[page - 1] : undefined;

    try {
      const res = await fetch('/api/projects/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: activeFilters.searchText || undefined,
          minPrice: activeFilters.minPrice ? Number(activeFilters.minPrice) : undefined,
          maxPrice: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : undefined,
          constructionPhases: activeFilters.completionStatus.length > 0 ? activeFilters.completionStatus : undefined,
          amenities: activeFilters.amenityIds.length > 0 ? activeFilters.amenityIds : undefined,
          sort: activeSort === 'created_at_desc' ? 'relevance' : activeSort,
          pageSize: ITEMS_PER_PAGE,
          cursor,
        }),
        signal,
      });

      if (res.ok) {
        const data = await res.json();
        if (fetchId !== fetchIdRef.current) return;
        const projectsData = (data.results || []) as Project[];
        setProjects(projectsData);
        setTotalCount(data.total || 0);
        setTotalPages(Math.ceil((data.total || 0) / ITEMS_PER_PAGE));
        if (data.nextCursor) {
          cursorRef.current = { ...cursorRef.current, [page]: data.nextCursor };
        }
        setLoading(false);
        return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // ES unavailable — fall through to RPC
    }

    if (fetchId !== fetchIdRef.current) return;

    const params: Record<string, any> = {
      p_page_num: page,
      p_items_per_page: ITEMS_PER_PAGE,
      p_sort_by: activeSort,
      p_search_text: activeFilters.searchText || null,
      p_completion_status: activeFilters.completionStatus.length > 0 ? activeFilters.completionStatus : null,
      p_bedrooms: activeFilters.bedrooms.length > 0 ? activeFilters.bedrooms : null,
      p_min_price: activeFilters.minPrice ? Number(activeFilters.minPrice) : null,
      p_max_price: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : null,
      p_amenity_ids: activeFilters.amenityIds.length > 0 ? activeFilters.amenityIds : null,
    };

    const { data, error: rpcError } = await supabase.rpc('search_projects', params);

    if (fetchId !== fetchIdRef.current) return;

    if (rpcError) {
      console.error('Error fetching projects:', rpcError);
      setError('Failed to load projects. Please try again later.');
      setProjects([]);
    } else {
      const projectsData = (data as any[] || []) as Project[];
      setProjects(projectsData);
      const count = projectsData[0]?.total_count || 0;
      setTotalCount(count);
      setTotalPages(Math.ceil(count / ITEMS_PER_PAGE));
    }
    setLoading(false);
  }, []);

  fetchProjectsRef.current = fetchProjectsImpl;

  const debouncedFetch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      (fetchProjectsRef.current as any)();
    }, 500);
  }, []);

  useEffect(() => {
    const fetchLookupData = async () => {
      const [amenities, statuses] = await Promise.all([
        getLookup('amenities'),
        getCachedRpc<any[]>('distinct_completion_status', 'distinct_completion_status'),
      ]);
      setLookupData({
        amenities: amenities || [],
        completionStatuses: (statuses || []).map((s: any) => s.construction_phase).filter(Boolean),
      });
    };
    fetchLookupData();
  }, []);

  useEffect(() => { fetchProjectsImpl(); }, []);

  const handleFilterChange = (filterName: keyof Filters, value: any) => {
    setCurrentPage(1);
    cursorRef.current = {};
    setFilters(prev => {
      if (Array.isArray(prev[filterName])) {
        const list = prev[filterName] as any[];
        const newList = list.includes(value) ? list.filter(item => item !== value) : [...list, value];
        return { ...prev, [filterName]: newList };
      }
      return { ...prev, [filterName]: value };
    });
    debouncedFetch();
  };

  const clearFilters = () => {
    setCurrentPage(1);
    cursorRef.current = {};
    setFilters({ searchText: '', completionStatus: [], bedrooms: [], minPrice: '', maxPrice: '', amenityIds: [] });
    setAmenitySearchTerm('');
    setShowAllAmenities(false);
    debouncedFetch();
  };

  const activeFilterCount =
    filters.completionStatus.length + filters.bedrooms.length +
    (filters.minPrice ? 1 : 0) + (filters.maxPrice ? 1 : 0) +
    filters.amenityIds.length;

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-4 sm:p-6 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-4 text-center text-text-color-dark">Projects</h1>
        <p className="text-center text-text-color-light mb-8">{totalCount} projects found</p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-8 shadow-neumorphic-outset p-3 rounded-3xl">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-color-light pointer-events-none" size={18} />
            <input
              type="text"
              placeholder="Search by project name..."
              value={filters.searchText}
              onChange={e => handleFilterChange('searchText', e.target.value)}
              className="w-full !pl-10 !pr-4 neumorphic-input"
            />
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sortBy}
              onChange={e => { setCurrentPage(1); cursorRef.current = {}; setSortBy(e.target.value); debouncedFetch(); }}
              className="neumorphic-input !w-auto !min-w-[140px]"
            >
              <option value="created_at_desc">Newest</option>
              <option value="price_asc">Price: Low → High</option>
              <option value="price_desc">Price: High → Low</option>
              <option value="date_asc">Delivery: Soonest</option>
              <option value="date_desc">Delivery: Latest</option>
            </select>
            <button onClick={() => setIsFilterOpen(true)} className="neumorphic-button flex items-center gap-2 relative">
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
          lookupData={lookupData}
          onFilterChange={handleFilterChange}
          onClearFilters={clearFilters}
          amenitySearchTerm={amenitySearchTerm}
          onAmenitySearchChange={setAmenitySearchTerm}
          showAllAmenities={showAllAmenities}
          onToggleShowAllAmenities={() => setShowAllAmenities(prev => !prev)}
        />
        {isFilterOpen && <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setIsFilterOpen(false)} />}

        {loading && (
          <div className="flex justify-center py-20">
            <Loader2 className="animate-spin h-12 w-12 text-text-color-light" />
          </div>
        )}
        {error && (
          <div className="text-lg text-danger-color text-center py-10 bg-red-100 rounded-2xl p-4">
            <p className="font-semibold">Error</p>
            <p className="text-sm mt-1">{error}</p>
          </div>
        )}
        {!loading && !error && projects.length === 0 && (
          <p className="text-lg text-center py-10 text-text-color-light">No projects found matching your criteria. Try adjusting your filters.</p>
        )}
        {!loading && !error && projects.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {projects.map(project => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
            <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={(page) => { setCurrentPage(page); fetchProjectsImpl(page); }} />
          </>
        )}
      </main>
    </div>
  );
}
