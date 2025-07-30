// src/app/newprojects/page.tsx
'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabaseClient';
import Header from '@/app/components/Header';
import { ProjectCard } from '@/app/components/ProjectCard';
import { Loader2, Filter, X, Search } from 'lucide-react';
import { Project } from '@/lib/types';

// Define types for our filters and lookup data
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

const BEDROOM_OPTIONS = [0, 1, 2, 3, 4, 5]; // 0 for Studio
const INITIAL_AMENITIES_COUNT = 8; // Number of amenities to show initially

// --- FIX: Define child components outside the main component ---

// FilterSidebar Component
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
    const filteredAmenities = useMemo(() => {
        return lookupData.amenities.filter(amenity =>
            amenity.name.toLowerCase().includes(amenitySearchTerm.toLowerCase())
        );
    }, [lookupData.amenities, amenitySearchTerm]);

    const displayedAmenities = showAllAmenities ? filteredAmenities : filteredAmenities.slice(0, INITIAL_AMENITIES_COUNT);

    return (
        <aside className={`fixed top-0 right-0 h-full w-80 bg-bg-color shadow-neumorphic-outset p-6 z-50 transform transition-transform ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">Filters</h2>
                <button onClick={onClose} className="neumorphic-button !p-2 !rounded-full"><X size={20} /></button>
            </div>
            <div className="space-y-6 overflow-y-auto h-[calc(100%-80px)] pr-2">
                <div>
                    <label className="font-semibold block mb-2">Bedrooms</label>
                    <div className="flex flex-wrap gap-2">
                        {BEDROOM_OPTIONS.map(bed => (
                            <button key={bed} onClick={() => onFilterChange('bedrooms', bed)} className={`neumorphic-button !text-sm ${filters.bedrooms.includes(bed) ? 'shadow-neumorphic-inset' : ''}`}>
                                {bed === 0 ? 'Studio' : `${bed} Bed`}
                            </button>
                        ))}
                    </div>
                </div>
                <div>
                    <label className="font-semibold block mb-2">Price Range (AED)</label>
                    <div className="flex gap-2">
                        <input type="number" placeholder="Min" value={filters.minPrice} onChange={e => onFilterChange('minPrice', e.target.value)} className="neumorphic-input w-full" />
                        <input type="number" placeholder="Max" value={filters.maxPrice} onChange={e => onFilterChange('maxPrice', e.target.value)} className="neumorphic-input w-full" />
                    </div>
                </div>
                <div>
                    <label className="font-semibold block mb-2">Completion Status</label>
                    <div className="flex flex-wrap gap-2">
                        {lookupData.completionStatuses.map(status => (
                            <button key={status} onClick={() => onFilterChange('completionStatus', status)} className={`neumorphic-button !text-sm capitalize ${filters.completionStatus.includes(status) ? 'shadow-neumorphic-inset' : ''}`}>
                                {status.replace(/_/g, ' ')}
                            </button>
                        ))}
                    </div>
                </div>
                <div>
                    <label className="font-semibold block mb-2">Amenities</label>
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
                    <div className="flex flex-wrap gap-2">
                        {displayedAmenities.map(amenity => (
                            <button key={amenity.id} onClick={() => onFilterChange('amenityIds', amenity.id)} className={`neumorphic-button !text-sm ${filters.amenityIds.includes(amenity.id) ? 'shadow-neumorphic-inset' : ''}`}>
                                {amenity.name}
                            </button>
                        ))}
                    </div>
                    {filteredAmenities.length > INITIAL_AMENITIES_COUNT && (
                        <button
                            onClick={onToggleShowAllAmenities}
                            className="text-blue-600 text-sm font-semibold mt-2 hover:underline"
                        >
                            {showAllAmenities ? 'View less' : `View more (${filteredAmenities.length - INITIAL_AMENITIES_COUNT} more)`}
                        </button>
                    )}
                </div>
                <button onClick={onClearFilters} className="w-full neumorphic-button !bg-danger-color/20 mt-4">Clear All Filters</button>
            </div>
        </aside>
    );
};

// Pagination Component
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


export default function NewProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // State for pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const ITEMS_PER_PAGE = 12;

  // State for sorting and filtering
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

  // State for the enhanced amenities filter
  const [amenitySearchTerm, setAmenitySearchTerm] = useState('');
  const [showAllAmenities, setShowAllAmenities] = useState(false);

  // Fetch projects from the new Supabase function
  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc('search_projects', {
      p_page_num: currentPage,
      p_items_per_page: ITEMS_PER_PAGE,
      p_sort_by: sortBy,
      p_search_text: filters.searchText || null,
      p_completion_status: filters.completionStatus.length > 0 ? filters.completionStatus : null,
      p_bedrooms: filters.bedrooms.length > 0 ? filters.bedrooms : null,
      p_min_price: filters.minPrice ? Number(filters.minPrice) : null,
      p_max_price: filters.maxPrice ? Number(filters.maxPrice) : null,
      p_amenity_ids: filters.amenityIds.length > 0 ? filters.amenityIds : null,
    });

    if (rpcError) {
      console.error('Error fetching projects:', rpcError);
      setError('Failed to load new projects. Please try again later.');
      setProjects([]);
    } else {
      const projectsData = (data as any[] || []) as Project[];
      setProjects(projectsData);
      const count = projectsData.length > 0 ? projectsData[0].total_count : 0;
      setTotalCount(count);
      setTotalPages(Math.ceil(count / ITEMS_PER_PAGE));
    }
    setLoading(false);
  }, [currentPage, sortBy, filters]);

  // Fetch initial lookup data for filters
  useEffect(() => {
    const fetchLookupData = async () => {
        const { data: amenities, error: amenitiesError } = await supabase.from('amenities').select('id, name');
        const { data: statuses, error: statusesError } = await supabase.rpc('distinct_completion_status');

        if (amenitiesError || statusesError) {
            console.error("Failed to load filter options");
        } else {
            setLookupData({
                amenities: amenities || [],
                completionStatuses: (statuses as any[] || []).map(s => s.construction_phase).filter(Boolean)
            });
        }
    };
    fetchLookupData();
  }, []);

  // Re-fetch projects when dependencies change
  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleFilterChange = (filterName: keyof Filters, value: any) => {
    setCurrentPage(1); // Reset to first page on any filter change
    setFilters(prev => {
        if (Array.isArray(prev[filterName])) {
            const list = prev[filterName] as any[];
            const newList = list.includes(value) ? list.filter(item => item !== value) : [...list, value];
            return { ...prev, [filterName]: newList };
        }
        return { ...prev, [filterName]: value };
    });
  };

  const clearFilters = () => {
    setCurrentPage(1);
    setFilters({
        searchText: '',
        completionStatus: [],
        bedrooms: [],
        minPrice: '',
        maxPrice: '',
        amenityIds: [],
    });
    setAmenitySearchTerm('');
    setShowAllAmenities(false);
  }

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-4 sm:p-6 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-4 text-center text-text-color-dark">New Projects</h1>
        <p className="text-center text-text-color-light mb-8">{totalCount} projects found</p>

        {/* Controls */}
        <div className="flex flex-col md:flex-row gap-4 justify-between items-center mb-8 shadow-neumorphic-outset p-4 rounded-3xl">
            <input type="text" placeholder="Search by project name..." value={filters.searchText} onChange={e => handleFilterChange('searchText', e.target.value)} className="neumorphic-input w-full md:w-auto"/>
            <div className="flex items-center gap-4">
                <select value={sortBy} onChange={e => { setCurrentPage(1); setSortBy(e.target.value); }} className="neumorphic-input">
                    <option value="created_at_desc">Newest</option>
                    <option value="price_asc">Price: Low to High</option>
                    <option value="price_desc">Price: High to Low</option>
                    <option value="date_asc">Delivery: Soonest</option>
                    <option value="date_desc">Delivery: Latest</option>
                </select>
                <button onClick={() => setIsFilterOpen(true)} className="neumorphic-button flex items-center gap-2">
                    <Filter size={16} /> Filters
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
        {isFilterOpen && <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setIsFilterOpen(false)}></div>}

        {/* Content */}
        {loading && <div className="flex justify-center py-20"><Loader2 className="animate-spin h-12 w-12 text-text-color-light" /></div>}
        {error && <div className="text-lg text-danger-color text-center py-10 bg-red-100 rounded-2xl p-4"><p className="font-semibold">Error</p><p className="text-sm mt-1">{error}</p></div>}
        
        {!loading && !error && projects.length === 0 && (
          <p className="text-lg text-center py-10 text-text-color-light">No projects found matching your criteria. Try adjusting your filters.</p>
        )}

        {!loading && !error && projects.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
            <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
          </>
        )}
      </main>
    </div>
  );
}
