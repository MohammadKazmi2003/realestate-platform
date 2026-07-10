// src/app/add-property/page.tsx
'use client';

import { useState, useEffect, FormEvent, ChangeEvent, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getLookup } from '@/lib/lookupCache';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import imageCompression from 'browser-image-compression';
import Fuse from 'fuse.js';
import { Loader2, UploadCloud, Building, Home, LandPlot, Trash2 } from 'lucide-react';
import dynamic from 'next/dynamic';

const LocationPicker = dynamic(() => import('@/app/components/LocationPicker'), {
  loading: () => <div className="h-72 flex items-center justify-center shadow-neumorphic-inset rounded-2xl"><Loader2 className="animate-spin text-text-color-light" /><span className="ml-2">Loading Map...</span></div>,
  ssr: false
});

// --- TYPE DEFINITIONS ---
type LookupType = { id: number; name: string; parent_id?: number | null; };
type BhkType = { id: number; label: string; };
type Amenity = { id: number; name: string; category: string; property_type_scope: string; };
type FurnishingItem = { id: number; name: string; category: string; };
type ImageUpload = { id: string; file: File; preview: string; tag: string; };

const residentialImageTags = ['Living Room', 'Bedroom', 'Bathroom', 'Kitchen', 'Balcony', 'Pooja Room', 'Study Room', 'Servant Room', 'Store Room'];
const commercialImageTags = ['Reception Area', 'Conference Room', 'Workstation Area', 'Director Cabin', 'Pantry', 'Facade'];
const commonImageTags = ['Exterior', 'Entrance', 'Floor Plan', 'Master Plan', 'Location Map', 'Other'];

/** Maps common search terms to amenity names for semantic matching. */
const amenitySynonyms: Record<string, string[]> = {
    workout: ['Gym', 'Fitness Centre / GYM', 'Gymnasium', 'Private Gym', 'Shared Gym', 'Running Track', 'Tennis Courts'],
    swim: ['Swimming Pool', 'Indoor Swimming Pool', 'Infinity Pool', 'Private Pool', 'Shared Pool', "Children's Pool"],
    car: ['Visitor Parking', 'Covered Parking', 'Basement Parking', 'Valet Parking', 'Garage', 'Parking', 'Private Marina Berths'],
    bike: ['Bicycle Track', 'Cycle track', 'Covered Parking'],
    kids: ['Children Play Area', "Children's Play Area", "Children's Pool", 'Day Care Centre', 'Children Nursery'],
    play: ['Children Play Area', "Children's Play Area", 'Tennis Courts', 'Squash Court', 'Golf Course', 'Yoga room', 'Golf Club and Clubhouse'],
    party: ['Community Hall', 'Ballroom', 'Barbecue Area', 'Club House', 'Club house / Community Center'],
    food: ['Cafe and Restaurants', 'Restaurants', 'Dine-in Cinema', 'Barbecue Area', 'Kitchen Appliances', 'Fully Fitted Kitchen', 'Pantry'],
    shop: ['Shopping Centre', 'Retail Facilities', 'Pharmacy'],
    security: ['CCTV', 'CCTV Security', '24x7 Security', 'Security / Fire Alarm', 'Intercom Facility', 'Security Personnel', 'Security'],
    prayer: ['Prayer Rooms', 'Mosque'],
    view: ['Panoramic Views', 'View of Landmark', 'View of Water', 'Balcony', 'Private Garden', 'Private Garden / Terrace'],
    garden: ['Garden', 'Landscaped Gardens', 'Landscaped Parks', 'Community Park', 'Private Garden', 'Private Garden / Terrace', 'Courtyard'],
    water: ['Swimming Pool', 'Indoor Swimming Pool', 'Infinity Pool', 'Private Pool', 'Shared Pool', 'Water Storage', 'Water purifier', 'Rain Water Harvesting', 'Water softening plant'],
    office: ['Conference Room', 'Reception Area', 'Director Cabin', 'Business centre', 'Business Facilities', 'Meeting rooms', 'Internet/Wi-Fi connectivity'],
    power: ['Power Backup'],
    internet: ['Internet/Wi-Fi connectivity', 'Networked'],
    ac: ['Centrally Air Conditioned', 'Central A/C'],
    pet: ['Pets Allowed'],
    elderly: ['Lift(s)', 'Lift', 'High Speed Elevators'],
};

function AddPropertyPage() {
    const router = useRouter();

    // --- STATE MANAGEMENT ---
    const [propertyTypeId, setPropertyTypeId] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const [commonData, setCommonData] = useState({ title: '', description: '', price: '', location_text: '', listing_purpose_id: '', ownership_type_id: '', availability_status_id: '', phone_number: '' });
    const [residentialData, setResidentialData] = useState({ bhk_type_id: '', bathrooms: '', balconies: '', total_floors: '', property_on_floor: '', furnishing_status_id: '', carpet_area: '', built_up_area: '', super_built_up_area: '' });
    const [commercialData, setCommercialData] = useState({ commercial_sub_type_id: '', office_type_id: '', min_seats: '', max_seats: '', cabins: '', meeting_rooms: '', private_washrooms: '', shared_washrooms: '', passenger_lifts: '', service_lifts: '', is_pre_leased: false, has_noc: false, has_occupancy_cert: false, carpet_area: '', total_floors: '', property_on_floor: '' });
    const [landData, setLandData] = useState({ plot_area: '', area_unit: 'sqft', is_boundary_wall_made: false });
    
    const [selectedAmenities, setSelectedAmenities] = useState<Set<number>>(new Set());
    const [selectedFurnishings, setSelectedFurnishings] = useState<Set<number>>(new Set());
    const [selectedOtherRooms, setSelectedOtherRooms] = useState<Set<number>>(new Set());
    const [selectedLocationAdvantages, setSelectedLocationAdvantages] = useState<Set<number>>(new Set());
    const [selectedLandFeatures, setSelectedLandFeatures] = useState<Set<number>>(new Set());
    
    const [amenitySearch, setAmenitySearch] = useState('');

    const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | null>(null);
    const [imageUploads, setImageUploads] = useState<ImageUpload[]>([]);
    
    const [lookupData, setLookupData] = useState<{
        propertyTypes: LookupType[], bhkTypes: BhkType[], listingPurposes: LookupType[],
        ownershipTypes: LookupType[], availabilityStatuses: LookupType[], furnishingStatuses: LookupType[],
        otherRooms: LookupType[], amenities: Amenity[], furnishingItems: FurnishingItem[],
        commercialSubTypes: LookupType[], commercialOfficeTypes: LookupType[], locationAdvantages: LookupType[],
        landFeatures: LookupType[]
    }>({
        propertyTypes: [], bhkTypes: [], listingPurposes: [], ownershipTypes: [],
        availabilityStatuses: [], furnishingStatuses: [], otherRooms: [], amenities: [],
        furnishingItems: [], commercialSubTypes: [], commercialOfficeTypes: [], locationAdvantages: [],
        landFeatures: []
    });

    // --- DATA FETCHING ---
    useEffect(() => {
        const fetchLookups = async () => {
            setIsLoading(true);
            try {
                const results = await Promise.all([
                    getLookup('property_types'),
                    getLookup('bhk_types'),
                    getLookup('lookup_listing_purposes'),
                    getLookup('lookup_ownership_types'),
                    getLookup('lookup_availability_statuses'),
                    getLookup('lookup_furnishing_statuses'),
                    getLookup('lookup_amenities'),
                    getLookup('lookup_furnishing_items'),
                    getLookup('lookup_other_rooms'),
                    getLookup('lookup_commercial_sub_types'),
                    getLookup('lookup_commercial_office_types'),
                    getLookup('lookup_location_advantages'),
                    getLookup('lookup_land_features'),
                ]);
                const [propTypeData, bhkTypeData, purposeData, ownerData, availData, furnishStatusData, amenityData, furnishItemData, otherRoomData, commSubTypeData, commOfficeTypeData, locAdvData, landFeatureData] = results;

                setLookupData({
                    propertyTypes: propTypeData,
                    bhkTypes: bhkTypeData,
                    listingPurposes: purposeData,
                    ownershipTypes: ownerData,
                    availabilityStatuses: availData,
                    furnishingStatuses: furnishStatusData,
                    amenities: amenityData,
                    furnishingItems: furnishItemData,
                    otherRooms: otherRoomData,
                    commercialSubTypes: commSubTypeData,
                    commercialOfficeTypes: commOfficeTypeData,
                    locationAdvantages: locAdvData,
                    landFeatures: landFeatureData,
                });
            } catch (error: any) {
                setMessage({ type: 'error', text: `Failed to load form options: ${error.message}` });
            } finally {
                setIsLoading(false);
            }
        };
        fetchLookups();
    }, []);

    // --- SMART CONDITIONAL LOGIC ---
    const selectedPropertyType = useMemo(() => {
        return lookupData.propertyTypes.find(p => String(p.id) === propertyTypeId) || null;
    }, [propertyTypeId, lookupData.propertyTypes]);

    /** The parent category (Residential, Commercial, Land / Plot) — follows parent_id chain. */
    const selectedParentType = useMemo(() => {
        if (!selectedPropertyType) return null;
        if (selectedPropertyType.parent_id == null) return selectedPropertyType;
        return lookupData.propertyTypes.find(p => p.id === selectedPropertyType.parent_id) || selectedPropertyType;
    }, [selectedPropertyType, lookupData.propertyTypes]);

    const selectedPropertyTypeName = selectedPropertyType?.name || null;
    const selectedParentTypeName = selectedParentType?.name || null;

    const parentCategories = useMemo(() => {
        return lookupData.propertyTypes.filter(pt => pt.parent_id == null);
    }, [lookupData.propertyTypes]);

    const subTypesForParent = useMemo(() => {
        if (!selectedParentType) return [];
        return lookupData.propertyTypes.filter(pt => pt.parent_id === selectedParentType.id);
    }, [selectedParentType, lookupData.propertyTypes]);

    const availableListingPurposes = useMemo(() => {
        if (selectedParentTypeName === 'Land / Plot') {
            return lookupData.listingPurposes.filter(p => p.name !== 'PG' & p.name !== 'Rent');
        }
        if (selectedParentTypeName === 'Commercial') return lookupData.listingPurposes.filter(p => p.name !== 'PG');
        if (selectedParentTypeName === 'Residential') return lookupData.listingPurposes.filter(p => p.name !== 'Lease');
        return lookupData.listingPurposes;
    }, [selectedParentTypeName, lookupData.listingPurposes]);
    
    const availableAmenitiesForType = useMemo(() => {
        if (!selectedParentTypeName) return [];

        // Use property_type_scope from the database to filter dynamically.
        // 'Both' scoped amenities show for all types. 'Residential'/'Commercial'
        // scope filters to that specific type. This is data-driven — adding a new
        // amenity with the correct scope automatically shows it in the right form.
        if (selectedParentTypeName === 'Residential' || selectedParentTypeName === 'Commercial') {
            return lookupData.amenities.filter(a =>
                a.property_type_scope === 'Both' || a.property_type_scope === selectedParentTypeName
            );
        }

        // Land / Plot: only land-relevant amenities (hardcoded — no Land scope exists)
        const landRelevantAmenities = ['Water Storage', 'Security / Fire Alarm', 'Security Personnel', 'Visitor Parking'];
        if (selectedParentTypeName === 'Land / Plot') {
            return lookupData.amenities.filter(a => landRelevantAmenities.includes(a.name));
        }

        return [];
    }, [selectedParentTypeName, lookupData.amenities]);

    const availableImageTags = useMemo(() => {
        if (selectedParentTypeName === 'Residential') return [...residentialImageTags, ...commonImageTags];
        if (selectedParentTypeName === 'Commercial') return [...commercialImageTags, ...commonImageTags];
        if (selectedParentTypeName === 'Land / Plot') return commonImageTags.filter(tag => !['Floor Plan', 'Pooja Room', 'Study Room', 'Servant Room'].includes(tag));
        return commonImageTags;
    }, [selectedParentTypeName]);

    // --- EVENT HANDLERS ---
    const handleCommonChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setCommonData(prev => ({ ...prev, [e.target.name]: e.target.value }));
    const handleResidentialChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setResidentialData(prev => ({ ...prev, [e.target.name]: e.target.value }));
    const handleCommercialChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setCommercialData(prev => ({ ...prev, [e.target.name]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
    const handleLandChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        setLandData(prev => ({ ...prev, [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value }));
    };
    const handleCheckboxChange = (setter: React.Dispatch<React.SetStateAction<Set<number>>>, id: number) => { setter(prev => { const newSet = new Set(prev); if (newSet.has(id)) newSet.delete(id); else newSet.add(id); return newSet; }); };
    
    const handleMediaChange = (e: ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files) {
            const newUploads: ImageUpload[] = Array.from(files).map(file => ({ id: self.crypto.randomUUID(), file, preview: URL.createObjectURL(file), tag: '' }));
            setImageUploads(prev => [...prev, ...newUploads]);
        }
    };
    
    const handleTagChange = (id: string, newTag: string) => setImageUploads(prev => prev.map(upload => upload.id === id ? { ...upload, tag: newTag } : upload));
    const handleRemoveImage = (id: string) => { const uploadToRemove = imageUploads.find(upload => upload.id === id); if (uploadToRemove) URL.revokeObjectURL(uploadToRemove.preview); setImageUploads(prev => prev.filter(upload => upload.id !== id)); };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setMessage(null);

        if (imageUploads.some(upload => upload.tag.trim() === '')) {
            setMessage({ type: 'error', text: 'Please select a tag for every uploaded image.' });
            setIsSubmitting(false);
            return;
        }

        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            setMessage({ type: 'error', text: 'You must be logged in.' });
            setIsSubmitting(false);
            return;
        }

        try {
            const { data, error } = await supabase.functions.invoke('create-listing', {
                body: { 
                    propertyTypeId, 
                    commonData, 
                    residentialData, 
                    commercialData, 
                    landData, 
                    amenities: Array.from(selectedAmenities), 
                    furnishings: Array.from(selectedFurnishings),
                    otherRooms: Array.from(selectedOtherRooms),
                    locationAdvantages: Array.from(selectedLocationAdvantages),
                    landFeatures: Array.from(selectedLandFeatures),
                    coordinates 
                }
            });

            if (error) throw error;
            const propertyId = data?.propertyId;
            if (!propertyId) throw new Error("Edge function did not return a property ID.");

            if (imageUploads.length > 0) {
                await Promise.all(imageUploads.map(async (upload, index) => {
                    const compressedFile = await imageCompression(upload.file, { maxSizeMB: 1, maxWidthOrHeight: 1920 });
                    const sanitizedFileName = upload.file.name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-.]/g, '');
                    const filePath = `${session.user.id}/${propertyId}/${Date.now()}-${sanitizedFileName}`;
                    
                    const { error: uploadError } = await supabase.storage.from('property-images').upload(filePath, compressedFile);
                    if (uploadError) throw new Error(`Failed to upload ${sanitizedFileName}: ${uploadError.message}`);
                    
                    const { data: urlData } = supabase.storage.from('property-images').getPublicUrl(filePath);
                    
                    await supabase.from('property_media').insert({ property_id: propertyId, media_url: urlData.publicUrl, media_type: upload.file.type.startsWith('image/') ? 'image' : 'brochure_pdf', tag: upload.tag, display_order: index });
                }));
            }

            setMessage({ type: 'success', text: 'Property listed successfully! Redirecting...' });
            setTimeout(() => router.push(`/property/${propertyId}`), 2000);

        } catch (err: any) {
            console.error("Submit Error:", err);
            const errorMessage = err.body?.error?.message || err.message || 'An unknown error occurred.';
            setMessage({ type: 'error', text: `Update failed: ${errorMessage}` });
        } finally {
            setIsSubmitting(false);
        }
    };
    
    if (isLoading) {
        return <div className="flex justify-center items-center min-h-screen"><Loader2 className="h-12 w-12 animate-spin" /></div>;
    }
    
    const AccordionChecklist = ({ title, items, selected, handler, searchQuery }: {
        title: string;
        items: (Amenity | FurnishingItem | LookupType)[];
        selected: Set<number>;
        handler: (id: number) => void;
        searchQuery?: string;
    }) => {
        const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());

        // Hybrid search: Fuse.js fuzzy + synonym dictionary
        const filteredItems = useMemo(() => {
            if (!searchQuery || searchQuery.trim() === '') return items;
            const q = searchQuery.toLowerCase().trim();

            // 1. Fuse.js fuzzy search on name
            const fuse = new Fuse(items, { keys: ['name'], threshold: 0.4 });
            const matched = new Set<number>();
            fuse.search(q).forEach(r => matched.add(r.item.id));

            // 2. Synonym dictionary for semantic matches
            for (const [synonym, amenityNames] of Object.entries(amenitySynonyms)) {
                if (q.includes(synonym) || synonym.includes(q)) {
                    items.forEach(item => {
                        if (amenityNames.some(name => item.name.toLowerCase().includes(name.toLowerCase()))) {
                            matched.add(item.id);
                        }
                    });
                }
            }

            return items.filter(item => matched.has(item.id));
        }, [items, searchQuery]);

        if (!filteredItems || filteredItems.length === 0) {
            if (searchQuery) return null;
            return null;
        }

        const categories: { [key: string]: typeof items } = filteredItems.reduce((acc, item) => {
            const category = (item as any).category || 'General';
            if (!acc[category]) acc[category] = [];
            acc[category].push(item);
            return acc;
        }, {} as { [key: string]: typeof items });

        const categoryNames = Object.keys(categories).sort();

        // Auto-expand all categories when search is active; collapse when cleared
        useEffect(() => {
            if (searchQuery && searchQuery.trim() !== '') {
                setOpenCategories(new Set(categoryNames));
            } else {
                setOpenCategories(new Set());
            }
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [searchQuery]);

        const toggleCategory = (name: string) => {
            setOpenCategories(prev => {
                const next = new Set(prev);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
            });
        };

        return (
            <div className="mt-6">
                <h3 className="font-semibold mb-4 text-text-color-dark">{title}</h3>
                <div className="space-y-2">
                    {categoryNames.map(category => {
                        const isOpen = openCategories.has(category);
                        const itemsInCategory = categories[category];
                        const selectedCount = itemsInCategory.filter(item => selected.has(item.id)).length;
                        return (
                            <div key={category} className="rounded-2xl shadow-neumorphic-outset overflow-hidden bg-bg-color">
                                <button
                                    type="button"
                                    onClick={() => toggleCategory(category)}
                                    className="w-full flex items-center justify-between p-4 text-sm font-medium text-text-color-dark hover:bg-shadow-dark/5 transition-colors"
                                >
                                    <span>{category} <span className="text-text-color-light font-normal">({itemsInCategory.length})</span></span>
                                    <span className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}>
                                        ▼
                                    </span>
                                </button>
                                {isOpen && (
                                    <div className="px-4 pb-4 pt-2 flex flex-wrap gap-3">
                                        {itemsInCategory.map(item => (
                                            <label key={item.id} className={`flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-2 cursor-pointer ${selected.has(item.id) ? 'shadow-neumorphic-inset' : ''}`}>
                                                <input type="checkbox" checked={selected.has(item.id)} onChange={() => handler(item.id)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>
                                                {(item as any).label || item.name}
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };

    return (
        <div className="bg-bg-color min-h-screen">
            <Header />
            <div className="max-w-4xl mx-auto my-8 p-6 sm:p-8 shadow-neumorphic-outset rounded-3xl">
                <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">List Your Property</h1>
                {message && <div className={`p-4 mb-6 rounded-lg ${message.type === 'error' ? 'bg-red-200 text-red-800' : 'bg-green-200 text-green-800'}`}>{message.text}</div>}
                
                <form onSubmit={handleSubmit} className="space-y-12">
                    <section>
                        <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">1. Select Property Type</h2>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {parentCategories.map(pt => (
                                <button type="button" key={pt.id} onClick={() => setPropertyTypeId(String(pt.id))} className={`neumorphic-button flex flex-col items-center justify-center p-6 gap-2 text-lg ${selectedParentType?.id === pt.id ? 'shadow-neumorphic-inset bg-cta-gradient' : ''}`}>
                                    {pt.name === 'Residential' && <Home />} {pt.name === 'Commercial' && <Building />} {pt.name === 'Land / Plot' && <LandPlot />}
                                    <span>{pt.name}</span>
                                </button>
                            ))}
                        </div>
                        {subTypesForParent.length > 0 && (
                            <div className="mt-4">
                                <label className="block text-sm font-medium text-text-color-light mb-2">Property Sub-type</label>
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                                    {subTypesForParent.map(st => (
                                        <button
                                            type="button"
                                            key={st.id}
                                            onClick={() => setPropertyTypeId(String(st.id))}
                                            className={`neumorphic-button flex items-center justify-center p-4 text-sm font-medium ${
                                                propertyTypeId === String(st.id) ? 'shadow-neumorphic-inset bg-cta-gradient' : ''
                                            }`}
                                        >
                                            {st.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {selectedParentType && !subTypesForParent.length && (
                            <p className="mt-3 text-sm text-text-color-light">Selected: <strong>{selectedParentType.name}</strong></p>
                        )}
                    </section>

                    {propertyTypeId && (
                        <>
                            <section>
                                <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">2. Core Listing Details</h2>
                                <div className="space-y-6">
                                    <div><label className="block text-sm font-medium text-text-color-light mb-1">Listing Title</label><input name="title" value={commonData.title} onChange={handleCommonChange} placeholder="e.g., 5 Acre Plot on Main Highway" required className="neumorphic-input"/></div>
                                    <div><label className="block text-sm font-medium text-text-color-light mb-1">Description</label><textarea name="description" value={commonData.description} onChange={handleCommonChange} rows={4} required className="neumorphic-input"/></div>
                                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                                        <div><label className="block text-sm font-medium text-text-color-light mb-1">WhatsApp Phone Number</label><input name="phone_number" type="tel" pattern="[0-9]{10}" title="Enter a 10-digit phone number" value={commonData.phone_number} onChange={handleCommonChange} required className="neumorphic-input"/></div>
                                        <div><label className="block text-sm font-medium text-text-color-light mb-1">This property is for</label>
                                            <select name="listing_purpose_id" value={commonData.listing_purpose_id} onChange={handleCommonChange} required className="neumorphic-input w-full">
                                                <option value="">Select Purpose...</option>
                                                {availableListingPurposes.map(lp => <option key={lp.id} value={lp.id}>{lp.name}</option>)}
                                            </select>
                                        </div>
                                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Price (INR)</label><input name="price" type="number" min="0" value={commonData.price} onChange={handleCommonChange} required className="neumorphic-input"/></div>
                                    </div>
                                </div>
                            </section>
                            
                            <section>
                                <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">3. Property Profile</h2>
                                {selectedParentTypeName === 'Residential' && (
                                    <div className="space-y-6">
                                        <div className="grid md:grid-cols-3 gap-6">
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Carpet Area (sq. ft.)</label><input name="carpet_area" type="number" min="0" value={residentialData.carpet_area} onChange={handleResidentialChange} required className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Built-up Area (sq. ft.)</label><input name="built_up_area" type="number" min="0" value={residentialData.built_up_area} onChange={handleResidentialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Super Built-up Area (sq. ft.)</label><input name="super_built_up_area" type="number" min="0" value={residentialData.super_built_up_area} onChange={handleResidentialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">BHK Type</label><select name="bhk_type_id" value={residentialData.bhk_type_id} onChange={handleResidentialChange} required className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.bhkTypes.map(bt => <option key={bt.id} value={bt.id}>{bt.label}</option>)}</select></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Bathrooms</label><input name="bathrooms" type="number" min="0" value={residentialData.bathrooms} onChange={handleResidentialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Balconies</label><input name="balconies" type="number" min="0" value={residentialData.balconies} onChange={handleResidentialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Total Floors</label><input name="total_floors" type="number" min="0" value={residentialData.total_floors} onChange={handleResidentialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Property on Floor</label><input name="property_on_floor" type="number" min="0" value={residentialData.property_on_floor} onChange={handleResidentialChange} className="neumorphic-input"/></div>
                                        </div>
                                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Furnishing Status</label><select name="furnishing_status_id" value={residentialData.furnishing_status_id} onChange={handleResidentialChange} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.furnishingStatuses.map(fs => <option key={fs.id} value={fs.id}>{fs.name}</option>)}</select></div>
                                    </div>
                                )}
                                {selectedParentTypeName === 'Commercial' && (
                                     <div className="space-y-6">
                                        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Carpet Area (sq. ft.)</label><input name="carpet_area" type="number" min="0" value={commercialData.carpet_area} onChange={handleCommercialChange} required className="neumorphic-input" /></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Commercial Property Type</label><select name="commercial_sub_type_id" value={commercialData.commercial_sub_type_id} onChange={handleCommercialChange} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.commercialSubTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Kind of Office</label><select name="office_type_id" value={commercialData.office_type_id} onChange={handleCommercialChange} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.commercialOfficeTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Min. Seats</label><input name="min_seats" type="number" min="0" value={commercialData.min_seats} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Max. Seats</label><input name="max_seats" type="number" min="0" value={commercialData.max_seats} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Private Cabins</label><input name="cabins" type="number" min="0" value={commercialData.cabins} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Meeting Rooms</label><input name="meeting_rooms" type="number" min="0" value={commercialData.meeting_rooms} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Private Washrooms</label><input name="private_washrooms" type="number" min="0" value={commercialData.private_washrooms} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Shared Washrooms</label><input name="shared_washrooms" type="number" min="0" value={commercialData.shared_washrooms} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Passenger Lifts</label><input name="passenger_lifts" type="number" min="0" value={commercialData.passenger_lifts} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Service Lifts</label><input name="service_lifts" type="number" min="0" value={commercialData.service_lifts} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Total Floors</label><input name="total_floors" type="number" min="0" value={commercialData.total_floors} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Property on Floor</label><input name="property_on_floor" type="number" min="0" value={commercialData.property_on_floor} onChange={handleCommercialChange} className="neumorphic-input"/></div>
                                        </div>
                                        <div className="pt-4 space-y-3">
                                            <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="is_pre_leased" checked={commercialData.is_pre_leased} onChange={handleCommercialChange} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is this property currently pre-leased?</label>
                                            <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="has_noc" checked={commercialData.has_noc} onChange={handleCommercialChange} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is your office NOC Certified?</label>
                                            <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="has_occupancy_cert" checked={commercialData.has_occupancy_cert} onChange={handleCommercialChange} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is an Occupancy Certificate available?</label>
                                        </div>
                                    </div>
                                )}
                                {selectedParentTypeName === 'Land / Plot' && (
                                    <div className="grid md:grid-cols-2 gap-6 items-center">
                                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Plot Area</label><input name="plot_area" type="number" min="0" value={landData.plot_area} onChange={handleLandChange} required className="neumorphic-input"/></div>
                                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Area Unit</label><select name="area_unit" value={landData.area_unit} onChange={handleLandChange} className="neumorphic-input w-full"><option value="sqft">Square Feet</option><option value="sqyd">Square Yards</option><option value="acre">Acres</option></select></div>
                                        <div className="md:col-span-2">
                                            <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer">
                                                <input type="checkbox" name="is_boundary_wall_made" checked={landData.is_boundary_wall_made} onChange={handleLandChange} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>
                                                Is a boundary wall made?
                                            </label>
                                        </div>
                                    </div>
                                )}
                            </section>
                            
                            <section>
                                <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">4. Features & Amenities</h2>
                                
                                <div className="mb-4">
                                    <input
                                        type="text"
                                        placeholder="Search amenities... (e.g. pool, gym, parking)"
                                        value={amenitySearch}
                                        onChange={e => setAmenitySearch(e.target.value)}
                                        className="neumorphic-input w-full"
                                    />
                                </div>

                                {selectedParentTypeName === 'Residential' && <AccordionChecklist title="Other Rooms" items={lookupData.otherRooms} selected={selectedOtherRooms} handler={(id) => handleCheckboxChange(setSelectedOtherRooms, id)} searchQuery={amenitySearch} />}
                                {selectedParentTypeName === 'Land / Plot' && <AccordionChecklist title="Land Features" items={lookupData.landFeatures} selected={selectedLandFeatures} handler={(id) => handleCheckboxChange(setSelectedLandFeatures, id)} searchQuery={amenitySearch} />}
                                {availableAmenitiesForType.length > 0 && <AccordionChecklist title="Amenities" items={availableAmenitiesForType} selected={selectedAmenities} handler={(id) => handleCheckboxChange(setSelectedAmenities, id)} searchQuery={amenitySearch} />}
                                {selectedParentTypeName === 'Residential' && <AccordionChecklist title="Furnishing Includes" items={lookupData.furnishingItems} selected={selectedFurnishings} handler={(id) => handleCheckboxChange(setSelectedFurnishings, id)} searchQuery={amenitySearch} />}
                                {<AccordionChecklist title="Location Advantages" items={lookupData.locationAdvantages} selected={selectedLocationAdvantages} handler={(id) => handleCheckboxChange(setSelectedLocationAdvantages, id)} searchQuery={amenitySearch} />}
                            </section>
                            
                            <section>
                               <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">5. Location</h2>
                               <div className="space-y-4">
                                  <LocationPicker onLocationChange={(lat, lng) => setCoordinates({ lat, lng })} />
                                  <div><label className="block text-sm font-medium text-text-color-light mb-1">Location / Area Name</label><input name="location_text" value={commonData.location_text} onChange={handleCommonChange} placeholder="e.g., Hiranandani Gardens, Powai, Mumbai" required className="neumorphic-input"/></div>
                               </div>
                            </section>
                            
                            <section>
                               <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">6. Media</h2>
                               <div className="p-4 shadow-neumorphic-inset rounded-2xl">
                                   <label htmlFor="media" className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-shadow-dark/30 rounded-xl cursor-pointer hover:bg-shadow-dark/10 transition-colors">
                                     <UploadCloud className="w-8 h-8 text-text-color-light mb-2"/>
                                     <span className="text-text-color-dark">Upload Images & Media</span>
                                     <span className="text-xs text-text-color-light">PNG, JPG, PDF accepted</span>
                                   </label>
                                   <input id="media" type="file" multiple onChange={handleMediaChange} className="hidden" accept="image/*,.pdf"/>
                                   {imageUploads.length > 0 && (
                                     <div className="mt-6">
                                       <p className="font-semibold text-text-color-dark mb-4">Image Previews:</p>
                                       <div className="max-h-96 overflow-y-auto space-y-4 pr-2">
                                           {imageUploads.map((upload) => (
                                             <div key={upload.id} className="flex items-center gap-4 p-2 rounded-lg bg-bg-color shadow-neumorphic-outset">
                                               <img src={upload.preview} alt="Preview" className="h-20 w-20 object-cover rounded-lg"/>
                                               <div className="flex-grow">
                                                   <label htmlFor={`tag-input-${upload.id}`} className="text-sm font-medium text-text-color-light">Tag this image</label>
                                                   <input id={`tag-input-${upload.id}`} list={`tags-list-${propertyTypeId}`} value={upload.tag} onChange={(e) => handleTagChange(upload.id, e.target.value)} className="neumorphic-input w-full mt-1" placeholder="Select or type a tag..." required />
                                               </div>
                                               <button type="button" onClick={() => handleRemoveImage(upload.id)} className="p-2 text-danger-color hover:bg-danger-color/10 rounded-full"><Trash2 size={18}/></button>
                                             </div>
                                           ))}
                                       </div>
                                       <datalist id={`tags-list-${propertyTypeId}`}>
                                         {availableImageTags.map(tag => (<option key={tag} value={tag} />))}
                                       </datalist>
                                     </div>
                                   )}
                               </div>
                            </section>
                            
                            <button type="submit" disabled={isSubmitting || isLoading} className="w-full neumorphic-button bg-cta-gradient py-3 text-lg font-bold">
                                {isSubmitting ? <Loader2 className="animate-spin inline-block mr-2" /> : 'Submit Listing'}
                            </button>
                        </>
                    )}
                </form>
            </div>
        </div>
    );
}

export default withAuth(AddPropertyPage);
