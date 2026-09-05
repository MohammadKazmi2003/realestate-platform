// src/app/edit-property/[id]/page.tsx
'use client';

import React, { useState, useEffect, FormEvent, ChangeEvent, use,useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getLookup } from '@/lib/lookupCache';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import imageCompression from 'browser-image-compression';
import { XCircle, Loader2, UploadCloud, Trash2, Building, Home, LandPlot } from 'lucide-react';
import { updatePropertyAndManageImages } from '@/lib/actions';
import { unstable_noStore as noStore } from 'next/cache';
import type { PropertyDataType, LookupItem as BaseLookupType } from '@/lib/types';
import { tenant } from '@/lib/tenant';
import dynamic from 'next/dynamic';

const LocationPicker = dynamic(() => import('@/app/components/LocationPicker'), {
  loading: () => <div className="h-72 flex items-center justify-center shadow-neumorphic-inset rounded-2xl"><Loader2 className="animate-spin text-text-color-light" /><span className="ml-2">Loading Map...</span></div>,
  ssr: false
});

// --- TYPE DEFINITIONS ---
type LookupType = BaseLookupType;
type BhkType = { id: number; label: string; };
type Amenity = { id: number; name: string; category: string; property_type_scope: string; };
type FurnishingItem = { id: number; name: string; category: string; };
type ExistingImage = { id: number; media_url: string; tag: string; file_path: string; };
type NewImageFile = { file: File; preview: string; id: string; tag: string; };
type CommonFormData = { title: string; description: string; price: string; location_text: string; listing_purpose_id: string; ownership_type_id: string; availability_status_id: string; phone_number: string; };
type ResidentialFormData = { bhk_type_id: string; bathrooms: string; balconies: string; total_floors: string; property_on_floor: string; furnishing_status_id: string; carpet_area: string; built_up_area: string; super_built_up_area: string; };
type CommercialFormData = { commercial_sub_type_id: string; office_type_id: string; min_seats: string; max_seats: string; cabins: string; meeting_rooms: string; private_washrooms: string; shared_washrooms: string; passenger_lifts: string; service_lifts: string; is_pre_leased: boolean; has_noc: boolean; has_occupancy_cert: boolean; carpet_area: string; total_floors: string; property_on_floor: string; };
type LandFormData = { plot_area: string; area_unit: string; is_boundary_wall_made: boolean; };

interface EditPropertyPageProps {
  params: Promise<{ id: string }>;
}

function EditPropertyPage({ params: paramsPromise }: EditPropertyPageProps) {
  noStore();
  const params = use(paramsPromise);
  const { id: propertyId } = params;
  const router = useRouter();

  // --- STATE MANAGEMENT ---
  const [propertyTypeId, setPropertyTypeId] = useState<string>('');
  const [propertyTypeName, setPropertyTypeName] = useState<string>('');
  const [commonData, setCommonData] = useState<CommonFormData>({ title: '', description: '', price: '', location_text: '', listing_purpose_id: '', ownership_type_id: '', availability_status_id: '', phone_number: '' });
  const [residentialData, setResidentialData] = useState<ResidentialFormData>({ bhk_type_id: '', bathrooms: '', balconies: '', total_floors: '', property_on_floor: '', furnishing_status_id: '', carpet_area: '', built_up_area: '', super_built_up_area: '' });
  const [commercialData, setCommercialData] = useState<CommercialFormData>({ commercial_sub_type_id: '', office_type_id: '', min_seats: '', max_seats: '', cabins: '', meeting_rooms: '', private_washrooms: '', shared_washrooms: '', passenger_lifts: '', service_lifts: '', is_pre_leased: false, has_noc: false, has_occupancy_cert: false, carpet_area: '', total_floors: '', property_on_floor: '' });  const [landData, setLandData] = useState<LandFormData>({ plot_area: '', area_unit: 'sqft', is_boundary_wall_made: false });
  
  const [existingImages, setExistingImages] = useState<ExistingImage[]>([]);
  const [newImages, setNewImages] = useState<NewImageFile[]>([]);
  const [imagesToDelete, setImagesToDelete] = useState<{ id: number; file_path: string }[]>([]);
  
  const [selectedAmenities, setSelectedAmenities] = useState<Set<number>>(new Set());
  const [selectedFurnishings, setSelectedFurnishings] = useState<Set<number>>(new Set());
  const [selectedOtherRooms, setSelectedOtherRooms] = useState<Set<number>>(new Set());
  const [selectedLocationAdvantages, setSelectedLocationAdvantages] = useState<Set<number>>(new Set());
  const [selectedLandFeatures, setSelectedLandFeatures] = useState<Set<number>>(new Set());

  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [lookupData, setLookupData] = useState({
      bhkTypes: [] as BhkType[], listingPurposes: [] as LookupType[],
      ownershipTypes: [] as LookupType[], availabilityStatuses: [] as LookupType[],
      furnishingStatuses: [] as LookupType[], commercialSubTypes: [] as LookupType[],
      commercialOfficeTypes: [] as LookupType[], locationAdvantages: [] as LookupType[],
      amenities: [] as Amenity[], furnishingItems: [] as FurnishingItem[],
      otherRooms: [] as LookupType[], landFeatures: [] as LookupType[],
  });

  const availableAmenitiesForType = useMemo(() => {
    if (!propertyTypeName) return [];
    if (propertyTypeName === 'Residential' || propertyTypeName === 'Commercial') {
        return lookupData.amenities;
    }
    const landRelevantAmenities = ['Water Storage', 'Security / Fire Alarm', 'Security Personnel', 'Visitor Parking'];
    if (propertyTypeName === 'Land / Plot') {
        return lookupData.amenities.filter(a => landRelevantAmenities.includes(a.name));
    }
    return [];
  }, [propertyTypeName, lookupData.amenities]);

  // --- DATA FETCHING ---
    useEffect(() => {
      const fetchData = async () => {
          if (!propertyId) return;
          setLoading(true);
          try {
              const propDetailsPromise = supabase.rpc('get_property_details', { p_property_id: propertyId }).returns<PropertyDataType>().single();
              const lookupsPromise = Promise.all([
                  getLookup('bhk_types'), getLookup('lookup_listing_purposes'), getLookup('lookup_ownership_types'),
                  getLookup('lookup_furnishing_statuses'), getLookup('lookup_availability_statuses'),
                  getLookup('lookup_commercial_sub_types'), getLookup('lookup_commercial_office_types'),
                  getLookup('lookup_location_advantages'), getLookup('lookup_land_features'),
                  getLookup('lookup_amenities'), getLookup('lookup_furnishing_items'), getLookup('lookup_other_rooms'),
              ]);
              const [propDetailsRes, [bhkData, listingData, ownerData, furnishData, availData,
                  commSubTypeData, commOfficeTypeData, locAdvData, landFeatureData,
                  amenityData, furnishItemData, otherRoomData]] = await Promise.all([propDetailsPromise, lookupsPromise]);

            if (propDetailsRes.error || !propDetailsRes.data) throw new Error(propDetailsRes.error?.message || 'Property not found.');
            const property = propDetailsRes.data;
            
            setLookupData({
                bhkTypes: bhkData, listingPurposes: listingData,
                ownershipTypes: ownerData, furnishingStatuses: furnishData,
                availabilityStatuses: availData, commercialSubTypes: commSubTypeData,
                commercialOfficeTypes: commOfficeTypeData, locationAdvantages: locAdvData,
                landFeatures: landFeatureData, amenities: amenityData,
                furnishingItems: furnishItemData, otherRooms: otherRoomData,
            });

            const { data: { user } } = await supabase.auth.getUser();
            if (!user || user.id !== property.user_id) { router.replace('/my-listings'); return; }

            setPropertyTypeId(String(property.property_types?.id || ''));
            setPropertyTypeName(property.property_types?.name || '');
            setCommonData({
                title: property.title || '', description: property.description || '', price: String(property.price || ''),
                location_text: property.location_text || '', listing_purpose_id: String(property.lookup_listing_purposes?.id || ''),
                ownership_type_id: String(property.lookup_ownership_types?.id || ''), availability_status_id: String(property.lookup_availability_statuses?.id || ''),
                phone_number: property.profiles?.phone_number || '',
            });

            if (property.details_residential?.[0]) {
                const res = property.details_residential[0];
                setResidentialData({
                    bhk_type_id: String(res.bhk_types?.id || ''), bathrooms: String(res.bathrooms || ''),
                    balconies: String(res.balconies || ''), total_floors: String(res.total_floors || ''),
                    property_on_floor: String(res.property_on_floor || ''), furnishing_status_id: String(res.lookup_furnishing_statuses?.id || ''),
                    carpet_area: String(res.carpet_area || ''), built_up_area: String(res.built_up_area || ''),
                    super_built_up_area: String(res.super_built_up_area || ''),
                });
            }

            if (property.details_commercial?.[0]) {
              const com = property.details_commercial[0];
              setCommercialData({
                  commercial_sub_type_id: String(com.lookup_commercial_sub_types?.id || ''), office_type_id: String((com.office_type as any)?.id || ''),
                  min_seats: String(com.min_seats || ''), max_seats: String(com.max_seats || ''), cabins: String(com.cabins || ''),
                  meeting_rooms: String(com.meeting_rooms || ''), private_washrooms: String(com.private_washrooms || ''),
                  shared_washrooms: String(com.shared_washrooms || ''), passenger_lifts: String(com.passenger_lifts || ''),
                  service_lifts: String(com.service_lifts || ''), is_pre_leased: com.is_pre_leased || false,
                  has_noc: com.has_noc || false, has_occupancy_cert: com.has_occupancy_cert || false,
                  carpet_area: String(com.carpet_area || ''),total_floors: String(com.total_floors || ''),
                  property_on_floor: String(com.property_on_floor || ''), 
              });
            }

            if (property.details_land?.[0]) {
                const land = property.details_land[0];
                setLandData({
                    plot_area: String(land.plot_area || ''),
                    area_unit: land.area_unit || 'sqft',
                    is_boundary_wall_made: land.is_boundary_wall_made || false,
                });
            }
            
            setSelectedAmenities(new Set(property.lookup_amenities.map(item => item.id)));
            setSelectedFurnishings(new Set(property.lookup_furnishing_items.map(item => item.id)));
            setSelectedOtherRooms(new Set(property.lookup_other_rooms.map(item => item.id)));
            setSelectedLocationAdvantages(new Set(property.lookup_location_advantages.map(item => item.id)));
            // *** FIX: Correctly populate the land features state ***
            setSelectedLandFeatures(new Set((property as any).lookup_land_features?.map((item: LookupType) => item.id) || []));

            const validatedImages = property.property_media.map(img => ({ ...img, tag: img.tag || '', file_path: img.media_url.split('/property-images/')[1] })).filter(img => img.file_path);
            setExistingImages(validatedImages as ExistingImage[]);
        } catch (error: any) {
            setMessage({ type: 'error', text: `Failed to load property: ${error.message}` });
        } finally {
            setLoading(false);
        }
    };
    fetchData();
  }, [propertyId, router]);
  
  // --- EVENT HANDLERS (Unchanged) ---
  const createHandleChange = (setter: React.Dispatch<React.SetStateAction<any>>) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const isCheckbox = type === 'checkbox';
    setter((prev: any) => ({ ...prev, [name]: isCheckbox ? (e.target as HTMLInputElement).checked : value }));
  };
  const handleCheckboxChange = (setter: React.Dispatch<React.SetStateAction<Set<number>>>, id: number) => { setter(prev => { const newSet = new Set(prev); if (newSet.has(id)) newSet.delete(id); else newSet.add(id); return newSet; }); };
  const handleNewImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const newImageFiles = Array.from(files).map(file => ({ id: self.crypto.randomUUID(), file, preview: URL.createObjectURL(file), tag: '' }));
      setNewImages(prev => [...prev, ...newImageFiles]);
      e.target.value = '';
    }
  };
  const handleNewImageTagChange = (id: string, tag: string) => {
    setNewImages(prev => prev.map(img => img.id === id ? { ...img, tag } : img));
  };
  const handleRemoveNewImage = (id: string) => {
    const uploadToRemove = newImages.find(upload => upload.id === id);
    if (uploadToRemove) URL.revokeObjectURL(uploadToRemove.preview);
    setNewImages(prev => prev.filter(upload => upload.id !== id));
  };
  const handleRemoveExistingImage = (imageId: number) => {
    const imageToRemove = existingImages.find(img => img.id === imageId);
    if (imageToRemove) {
      setImagesToDelete(prev => [...prev, { id: imageToRemove.id, file_path: imageToRemove.file_path }]);
      setExistingImages(prev => prev.filter(img => img.id !== imageId));
    }
  };
  const handleExistingImageTagChange = (id: number, tag: string) => {
      setExistingImages(prev => prev.map(img => img.id === id ? {...img, tag} : img));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('User not authenticated.');

        const newImageDbEntries = await Promise.all(
          newImages.map(async (newImg, index) => {
              const compressedFile = await imageCompression(newImg.file, { maxSizeMB: 1, maxWidthOrHeight: 1920 });
              const filePath = `${user.id}/${propertyId}/${Date.now()}-${compressedFile.name.replace(/\s+/g, '-')}`;
              const { error: uploadError } = await supabase.storage.from('property-images').upload(filePath, compressedFile);
              if (uploadError) throw new Error(`Upload failed for ${compressedFile.name}: ${uploadError.message}`);
              const { data: { publicUrl } } = supabase.storage.from('property-images').getPublicUrl(filePath);
              return { media_url: publicUrl, tag: newImg.tag, media_type: 'image', display_order: existingImages.length + index };
          })
        );
        
        const existingImagesToUpdate = existingImages.map(img => ({ id: img.id, tag: img.tag }));
        
        const result = await updatePropertyAndManageImages(
            propertyId, user.id, propertyTypeId, commonData, residentialData, commercialData, landData,
            imagesToDelete, existingImagesToUpdate, newImageDbEntries,
            Array.from(selectedAmenities), Array.from(selectedFurnishings), Array.from(selectedOtherRooms),
            Array.from(selectedLocationAdvantages), Array.from(selectedLandFeatures)
        );

        if (!result.success) throw new Error(result.message);
        setMessage({ type: 'success', text: result.message + ' Redirecting...' });
        setTimeout(() => router.push(`/property/${propertyId}`), 1500);

    } catch (error: any) {
        setMessage({ type: 'error', text: `Update failed: ${error.message}` });
    } finally {
        setIsSubmitting(false);
    }
  };
  
  if (loading) return <div className="min-h-screen bg-bg-color flex items-center justify-center"><Loader2 className="h-12 w-12 animate-spin text-text-color-light" /></div>;

  const renderChecklist = (title: string, items: (Amenity | FurnishingItem | LookupType)[], selected: Set<number>, handler: (id: number) => void) => {
    if (!items || items.length === 0) return null;
    const categories: { [key: string]: typeof items } = items.reduce((acc, item) => {
        const category = (item as any).category || 'General';
        if (!acc[category]) acc[category] = [];
        acc[category].push(item);
        return acc;
    }, {} as { [key: string]: typeof items });

    return (
      <div className="mt-6">
        <h3 className="font-semibold mb-4 text-text-color-dark">{title}</h3>
        {Object.keys(categories).sort().map(category => (
          <div key={category} className="mb-4">
            <p className="text-sm font-medium text-text-color-light mb-2">{category}</p>
            <div className="flex flex-wrap gap-3">
              {categories[category].map(item => (
                <label key={item.id} className={`flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-2 cursor-pointer ${selected.has(item.id) ? 'shadow-neumorphic-inset' : ''}`}>
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => handler(item.id)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>
                  {(item as any).label || item.name}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
       <div className="max-w-4xl mx-auto my-8 p-6 sm:p-8 shadow-neumorphic-outset rounded-3xl">
        <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">Edit Property</h1>
        {message && <div className={`p-4 mb-6 text-sm rounded-lg ${ message.type === 'error' ? 'bg-red-200 text-red-800' : 'bg-green-200 text-green-800' }`}>{message.text}</div>}

        <form onSubmit={handleSubmit} className="space-y-12">
            {/* ... other sections remain unchanged ... */}
            <section>
                <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">1. Property Type</h2>
                <div className="neumorphic-button is-disabled flex flex-col items-center justify-center p-6 gap-2 text-lg shadow-neumorphic-inset bg-cta-gradient">
                    {propertyTypeName === 'Residential' && <Home />}
                    {propertyTypeName === 'Commercial' && <Building />}
                    {propertyTypeName === 'Land / Plot' && <LandPlot />}
                    <span>{propertyTypeName} (Cannot be changed)</span>
                </div>
            </section>

            <section>
                <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">2. Core Listing Details</h2>
                <div className="space-y-6">
                    <div><label className="block text-sm font-medium text-text-color-light mb-1">Title</label><input name="title" value={commonData.title} onChange={createHandleChange(setCommonData)} required className="neumorphic-input"/></div>
                    <div><label className="block text-sm font-medium text-text-color-light mb-1">Description</label><textarea name="description" value={commonData.description} onChange={createHandleChange(setCommonData)} rows={4} required className="neumorphic-input"/></div>
                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">WhatsApp Phone Number</label><input name="phone_number" type="tel" pattern="[0-9]{10}" title="Enter a 10-digit phone number" value={commonData.phone_number} onChange={createHandleChange(setCommonData)} required className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Price ({tenant.propertyCurrency})</label><input name="price" type="number" min="0" value={commonData.price} onChange={createHandleChange(setCommonData)} required className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Listing For</label><select name="listing_purpose_id" value={commonData.listing_purpose_id} onChange={createHandleChange(setCommonData)} required className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.listingPurposes.map(lp => <option key={lp.id} value={lp.id}>{lp.name}</option>)}</select></div>
                    </div>
                </div>
            </section>
            
            <section>
                <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">3. Property Profile</h2>
                {propertyTypeName === 'Residential' && (
                    <div className="space-y-6">
                        <div className="grid md:grid-cols-3 gap-6">
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Carpet Area (sq. ft.)</label><input name="carpet_area" type="number" min="0" value={residentialData.carpet_area} onChange={createHandleChange(setResidentialData)} required className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Built-up Area (sq. ft.)</label><input name="built_up_area" type="number" min="0" value={residentialData.built_up_area} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Super Built-up Area (sq. ft.)</label><input name="super_built_up_area" type="number" min="0" value={residentialData.super_built_up_area} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">BHK Type</label><select name="bhk_type_id" value={residentialData.bhk_type_id} onChange={createHandleChange(setResidentialData)} required className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.bhkTypes.map(bt => <option key={bt.id} value={bt.id}>{bt.label}</option>)}</select></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Bathrooms</label><input name="bathrooms" type="number" min="0" value={residentialData.bathrooms} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Balconies</label><input name="balconies" type="number" min="0" value={residentialData.balconies} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Total Floors</label><input name="total_floors" type="number" min="0" value={residentialData.total_floors} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Property on Floor</label><input name="property_on_floor" type="number" min="0" value={residentialData.property_on_floor} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                        </div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Furnishing Status</label><select name="furnishing_status_id" value={residentialData.furnishing_status_id} onChange={createHandleChange(setResidentialData)} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.furnishingStatuses.map(fs => <option key={fs.id} value={fs.id}>{fs.name}</option>)}</select></div>
                    </div>
                )}
                {propertyTypeName === 'Commercial' && (
                     <div className="space-y-6">
                        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Carpet Area (sq. ft.)</label><input name="carpet_area" type="number" min="0" value={commercialData.carpet_area} onChange={createHandleChange(setCommercialData)} required className="neumorphic-input" /></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Commercial Property Type</label><select name="commercial_sub_type_id" value={commercialData.commercial_sub_type_id} onChange={createHandleChange(setCommercialData)} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.commercialSubTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Kind of Office</label><select name="office_type_id" value={commercialData.office_type_id} onChange={createHandleChange(setCommercialData)} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.commercialOfficeTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Min. Seats</label><input name="min_seats" type="number" min="0" value={commercialData.min_seats} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Max. Seats</label><input name="max_seats" type="number" min="0" value={commercialData.max_seats} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Private Cabins</label><input name="cabins" type="number" min="0" value={commercialData.cabins} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Meeting Rooms</label><input name="meeting_rooms" type="number" min="0" value={commercialData.meeting_rooms} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Private Washrooms</label><input name="private_washrooms" type="number" min="0" value={commercialData.private_washrooms} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Shared Washrooms</label><input name="shared_washrooms" type="number" min="0" value={commercialData.shared_washrooms} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Passenger Lifts</label><input name="passenger_lifts" type="number" min="0" value={commercialData.passenger_lifts} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Service Lifts</label><input name="service_lifts" type="number" min="0" value={commercialData.service_lifts} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Total Floors</label><input name="total_floors" type="number" min="0" value={commercialData.total_floors} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                            <div><label className="block text-sm font-medium text-text-color-light mb-1">Property on Floor</label><input name="property_on_floor" type="number" min="0" value={commercialData.property_on_floor} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                        </div>
                        <div className="pt-4 space-y-3">
                            <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="is_pre_leased" checked={commercialData.is_pre_leased} onChange={createHandleChange(setCommercialData)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is this property currently pre-leased?</label>
                            <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="has_noc" checked={commercialData.has_noc} onChange={createHandleChange(setCommercialData)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is your office NOC Certified?</label>
                            <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="has_occupancy_cert" checked={commercialData.has_occupancy_cert} onChange={createHandleChange(setCommercialData)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is an Occupancy Certificate available?</label>
                        </div>
                    </div>
                )}
                {propertyTypeName === 'Land / Plot' && (
                    <div className="grid md:grid-cols-2 gap-6 items-center">
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Plot Area</label><input name="plot_area" type="number" min="0" value={landData.plot_area} onChange={createHandleChange(setLandData)} required className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Area Unit</label><select name="area_unit" value={landData.area_unit} onChange={createHandleChange(setLandData)} className="neumorphic-input w-full"><option value="sqft">Square Feet</option><option value="sqyd">Square Yards</option><option value="acre">Acres</option></select></div>
                        <div className="md:col-span-2"><label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="is_boundary_wall_made" checked={landData.is_boundary_wall_made} onChange={createHandleChange(setLandData)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is a boundary wall made?</label></div>
                    </div>
                )}
            </section>
            
            <section>
              <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-4">4. Features & Amenities</h2>
              {propertyTypeName === 'Residential' && renderChecklist("Other Rooms", lookupData.otherRooms, selectedOtherRooms, (id) => handleCheckboxChange(setSelectedOtherRooms, id))}
              {propertyTypeName === 'Land / Plot' && renderChecklist("Land Features", lookupData.landFeatures, selectedLandFeatures, (id) => handleCheckboxChange(setSelectedLandFeatures, id))}
              {renderChecklist("Amenities", availableAmenitiesForType, selectedAmenities, (id) => handleCheckboxChange(setSelectedAmenities, id))}              {propertyTypeName === 'Residential' && renderChecklist("Furnishing Includes", lookupData.furnishingItems, selectedFurnishings, (id) => handleCheckboxChange(setSelectedFurnishings, id))}
              {renderChecklist("Location Advantages", lookupData.locationAdvantages, selectedLocationAdvantages, (id) => handleCheckboxChange(setSelectedLocationAdvantages, id))}
            </section>

            <section>
              <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-6">5. Manage Media</h2>
              <div className="p-4 shadow-neumorphic-inset rounded-2xl">
                 {existingImages.length > 0 && (
                    <div className="mb-6">
                      <p className="block text-sm font-medium text-text-color-dark mb-3">Current Images</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                        {existingImages.map((img) => (
                          <div key={img.id} className="relative aspect-square rounded-xl overflow-hidden group shadow-neumorphic-outset p-1 bg-bg-color">
                            <img src={img.media_url} alt={img.tag || 'Property image'} className="w-full h-full object-cover rounded-lg"/>
                            <div className="absolute bottom-0 left-0 right-0 bg-black/60 p-1">
                                <input type="text" value={img.tag || ''} onChange={(e) => handleExistingImageTagChange(img.id, e.target.value)} className="w-full bg-transparent text-white text-xs border-0 focus:ring-0 p-1" placeholder="Add a tag..." />
                            </div>
                            <button type="button" onClick={() => handleRemoveExistingImage(img.id)} className="absolute top-1 right-1 bg-danger-color/80 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 backdrop-blur-sm"><XCircle size={20} /></button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                 <label htmlFor="newImages" className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-shadow-dark/30 rounded-xl cursor-pointer hover:bg-shadow-dark/10 transition-colors">
                   <UploadCloud className="w-8 h-8 text-text-color-light mb-2"/>
                   <span className="text-text-color-dark">Upload New Images</span>
                 </label>
                 <input id="newImages" type="file" multiple accept="image/*" onChange={handleNewImageChange} className="hidden"/>
                 {newImages.length > 0 && (
                    <div className="mt-6">
                      <p className="font-semibold text-text-color-dark mb-4">New Images to Upload:</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                        {newImages.map((img) => (
                          <div key={img.id} className="relative aspect-square rounded-xl overflow-hidden group shadow-neumorphic-outset p-1 bg-bg-color">
                            <img src={img.preview} alt="New Preview" className="w-full h-full object-cover rounded-lg"/>
                            <div className="absolute bottom-0 left-0 right-0 bg-black/60 p-1">
                                <input type="text" value={img.tag} onChange={(e) => handleNewImageTagChange(img.id, e.target.value)} className="w-full bg-transparent text-white text-xs border-0 focus:ring-0 p-1" placeholder="Add a tag..." required />
                            </div>
                            <button type="button" onClick={() => handleRemoveNewImage(img.id)} className="absolute top-1 right-1 bg-danger-color/80 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 backdrop-blur-sm"><Trash2 size={20} /></button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            </section>
            
            <button type="submit" disabled={isSubmitting || loading} className="w-full neumorphic-button bg-cta-gradient py-3 text-lg font-bold">
                {isSubmitting ? <Loader2 className="animate-spin inline-block mr-2" /> : 'Update Property'}
            </button>
        </form>
      </div>
    </div>
  );
}
export default withAuth(EditPropertyPage);
