'use client';

import React, { useState, useEffect, FormEvent, ChangeEvent, use } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import imageCompression from 'browser-image-compression';
import { XCircle, Loader2, UploadCloud, Trash2 } from 'lucide-react';
import { updatePropertyAndManageImages } from '@/lib/actions';
import { unstable_noStore as noStore } from 'next/cache';
import type { PropertyDataType } from '@/lib/types';

// --- TYPE DEFINITIONS ---
type LookupType = { id: number; name: string; };
type BhkType = { id: number; label: string; };
type ExistingImage = { id: number; media_url: string; file_path: string; };
type NewImageFile = { file: File; preview: string; id: string; };

type CommonFormData = { title: string; description: string; price: string; location_text: string; listing_purpose_id: string; ownership_type_id: string; availability_status_id: string; };
type ResidentialFormData = { bhk_type_id: string; bathrooms: string; balconies: string; total_floors: string; property_on_floor: string; furnishing_status_id: string; carpet_area: string; built_up_area: string; super_built_up_area: string; };
type CommercialFormData = { commercial_sub_type_id: string; office_type_id: string; min_seats: string; max_seats: string; cabins: string; meeting_rooms: string; private_washrooms: string; shared_washrooms: string; passenger_lifts: string; service_lifts: string; is_pre_leased: boolean; has_noc: boolean; has_occupancy_cert: boolean; carpet_area: string; };

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
  const [commonData, setCommonData] = useState<CommonFormData>({ title: '', description: '', price: '', location_text: '', listing_purpose_id: '', ownership_type_id: '', availability_status_id: '' });
  const [residentialData, setResidentialData] = useState<ResidentialFormData>({ bhk_type_id: '', bathrooms: '', balconies: '', total_floors: '', property_on_floor: '', furnishing_status_id: '', carpet_area: '', built_up_area: '', super_built_up_area: '' });
  const [commercialData, setCommercialData] = useState<CommercialFormData>({ commercial_sub_type_id: '', office_type_id: '', min_seats: '', max_seats: '', cabins: '', meeting_rooms: '', private_washrooms: '', shared_washrooms: '', passenger_lifts: '', service_lifts: '', is_pre_leased: false, has_noc: false, has_occupancy_cert: false, carpet_area: '' });
  
  const [existingImages, setExistingImages] = useState<ExistingImage[]>([]);
  const [newImages, setNewImages] = useState<NewImageFile[]>([]);
  const [imagesToDelete, setImagesToDelete] = useState<ExistingImage[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [lookupData, setLookupData] = useState({
      bhkTypes: [] as BhkType[], listingPurposes: [] as LookupType[],
      ownershipTypes: [] as LookupType[], availabilityStatuses: [] as LookupType[],
      furnishingStatuses: [] as LookupType[], commercialSubTypes: [] as LookupType[],
      commercialOfficeTypes: [] as LookupType[],
  });

  // --- DATA FETCHING ---
  useEffect(() => {
    const fetchData = async () => { 
        if (!propertyId) return;
        setLoading(true);
        try {
            const [ propDetailsRes, bhkRes, listingRes, ownerRes, furnishRes, availRes, commSubTypeRes, commOfficeTypeRes ] = await Promise.all([
              supabase.rpc('get_property_details', { p_property_id: propertyId }).returns<PropertyDataType>().single(),
              supabase.from('bhk_types').select('id, label'),
              supabase.from('lookup_listing_purposes').select('id, name'),
              supabase.from('lookup_ownership_types').select('id, name'),
              supabase.from('lookup_furnishing_statuses').select('id, name'),
              supabase.from('lookup_availability_statuses').select('id, name'),
              supabase.from('lookup_commercial_sub_types').select('id, name'),
              supabase.from('lookup_commercial_office_types').select('id, name'),
            ]);

            if (propDetailsRes.error || !propDetailsRes.data) throw new Error(propDetailsRes.error?.message || 'Property not found.');
            const property = propDetailsRes.data;
            
            setLookupData({
                bhkTypes: bhkRes.data || [], listingPurposes: listingRes.data || [],
                ownershipTypes: ownerRes.data || [], furnishingStatuses: furnishRes.data || [],
                availabilityStatuses: availRes.data || [], commercialSubTypes: commSubTypeRes.data || [],
                commercialOfficeTypes: commOfficeTypeRes.data || [],
            });

            const { data: { user } } = await supabase.auth.getUser();
            if (!user || user.id !== property.user_id) { router.replace('/my-listings'); return; }

            setPropertyTypeId(String(property.property_types?.id || ''));
            setCommonData({
                title: property.title || '', description: property.description || '', price: String(property.price || ''),
                location_text: property.location_text || '', listing_purpose_id: String(property.lookup_listing_purposes?.id || ''),
                ownership_type_id: String(property.lookup_ownership_types?.id || ''), availability_status_id: String(property.lookup_availability_statuses?.id || ''),
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
                  commercial_sub_type_id: String(com.lookup_commercial_sub_types?.id || ''), office_type_id: String(com.office_type_id || ''),
                  min_seats: String(com.min_seats || ''), max_seats: String(com.max_seats || ''), cabins: String(com.cabins || ''),
                  meeting_rooms: String(com.meeting_rooms || ''), private_washrooms: String(com.private_washrooms || ''),
                  shared_washrooms: String(com.shared_washrooms || ''), passenger_lifts: String(com.passenger_lifts || ''),
                  service_lifts: String(com.service_lifts || ''), is_pre_leased: com.is_pre_leased || false,
                  has_noc: com.has_noc || false, has_occupancy_cert: com.has_occupancy_cert || false,
                  carpet_area: String(com.carpet_area || ''),
              });
            }
            
            const validatedImages = property.property_media.map(img => ({ ...img, file_path: img.media_url.split('/property-images/')[1] })).filter(img => img.file_path);
            setExistingImages(validatedImages as ExistingImage[]);
        } catch (error: any) {
            setMessage({ type: 'error', text: `Failed to load property: ${error.message}` });
        } finally {
            setLoading(false);
        }
    };
    fetchData();
  }, [propertyId, router]);
  
  // --- EVENT HANDLERS ---
  const createHandleChange = (setter: React.Dispatch<React.SetStateAction<any>>) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const isCheckbox = type === 'checkbox';
    setter((prev: any) => ({ ...prev, [name]: isCheckbox ? (e.target as HTMLInputElement).checked : value }));
  };

  const handleNewImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const newImageFiles = Array.from(files).map(file => ({
        id: self.crypto.randomUUID(), file, preview: URL.createObjectURL(file),
      }));
      setNewImages(prev => [...prev, ...newImageFiles]);
      e.target.value = '';
    }
  };
  
  const handleRemoveNewImage = (id: string) => {
    const uploadToRemove = newImages.find(upload => upload.id === id);
    if (uploadToRemove) URL.revokeObjectURL(uploadToRemove.preview);
    setNewImages(prev => prev.filter(upload => upload.id !== id));
  };

  const handleRemoveExistingImage = (imageId: number) => {
    const imageToRemove = existingImages.find(img => img.id === imageId);
    if (imageToRemove) {
      setImagesToDelete(prev => [...prev, imageToRemove]);
      setExistingImages(prev => prev.filter(img => img.id !== imageId));
    }
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
              return { media_url: publicUrl, tag: 'New Image', media_type: 'image', display_order: existingImages.length + index };
          })
        );
        
        const result = await updatePropertyAndManageImages(
            propertyId, user.id, propertyTypeId, commonData, residentialData, commercialData,
            imagesToDelete, newImageDbEntries,
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

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
       <div className="max-w-4xl mx-auto my-8 p-6 sm:p-8 shadow-neumorphic-outset rounded-3xl">
        <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">Edit Property</h1>
        {message && <div className={`p-4 mb-6 text-sm rounded-lg ${ message.type === 'error' ? 'bg-red-200 text-red-800' : 'bg-green-200 text-green-800' }`}>{message.text}</div>}

        <form onSubmit={handleSubmit} className="space-y-12">
            <section>
              <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-6">Core Listing Details</h2>
              <div className="space-y-6">
                <div><label className="block text-sm font-medium text-text-color-light mb-1">Title</label><input name="title" value={commonData.title} onChange={createHandleChange(setCommonData)} required className="neumorphic-input"/></div>
                <div><label className="block text-sm font-medium text-text-color-light mb-1">Description</label><textarea name="description" value={commonData.description} onChange={createHandleChange(setCommonData)} rows={4} required className="neumorphic-input"/></div>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <div><label className="block text-sm font-medium text-text-color-light mb-1">Price (INR)</label><input name="price" type="number" min="0" value={commonData.price} onChange={createHandleChange(setCommonData)} required className="neumorphic-input"/></div>
                    <div><label className="block text-sm font-medium text-text-color-light mb-1">Listing For</label><select name="listing_purpose_id" value={commonData.listing_purpose_id} onChange={createHandleChange(setCommonData)} required className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.listingPurposes.map(lp => <option key={lp.id} value={lp.id}>{lp.name}</option>)}</select></div>
                    <div><label className="block text-sm font-medium text-text-color-light mb-1">Ownership</label><select name="ownership_type_id" value={commonData.ownership_type_id} onChange={createHandleChange(setCommonData)} required className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.ownershipTypes.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                </div>
              </div>
            </section>
            
            {propertyTypeId === '1' && (
              <section>
                <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-6">Residential Details</h2>
                 <div className="space-y-6">
                    <div className="grid md:grid-cols-3 gap-6">
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Carpet Area (sq. ft.)</label><input name="carpet_area" type="number" min="0" value={residentialData.carpet_area} onChange={createHandleChange(setResidentialData)} required className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Built-up Area</label><input name="built_up_area" type="number" min="0" value={residentialData.built_up_area} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Super Built-up Area</label><input name="super_built_up_area" type="number" min="0" value={residentialData.super_built_up_area} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">BHK Type</label><select name="bhk_type_id" value={residentialData.bhk_type_id} onChange={createHandleChange(setResidentialData)} required className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.bhkTypes.map(bt => <option key={bt.id} value={bt.id}>{bt.label}</option>)}</select></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Bathrooms</label><input name="bathrooms" type="number" min="0" value={residentialData.bathrooms} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Balconies</label><input name="balconies" type="number" min="0" value={residentialData.balconies} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Total Floors</label><input name="total_floors" type="number" min="0" value={residentialData.total_floors} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Property on Floor</label><input name="property_on_floor" type="number" min="0" value={residentialData.property_on_floor} onChange={createHandleChange(setResidentialData)} className="neumorphic-input"/></div>
                        <div><label className="block text-sm font-medium text-text-color-light mb-1">Furnishing</label><select name="furnishing_status_id" value={residentialData.furnishing_status_id} onChange={createHandleChange(setResidentialData)} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.furnishingStatuses.map(fs => <option key={fs.id} value={fs.id}>{fs.name}</option>)}</select></div>
                    </div>
                </div>
              </section>
            )}

            {propertyTypeId === '2' && (
              <section>
                  <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-6">Commercial Details</h2>
                   <div className="space-y-6">
                      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Carpet Area</label><input name="carpet_area" type="number" min="0" value={commercialData.carpet_area} onChange={createHandleChange(setCommercialData)} required className="neumorphic-input" /></div>
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Commercial Type</label><select name="commercial_sub_type_id" value={commercialData.commercial_sub_type_id} onChange={createHandleChange(setCommercialData)} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.commercialSubTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Kind of Office</label><select name="office_type_id" value={commercialData.office_type_id} onChange={createHandleChange(setCommercialData)} className="neumorphic-input w-full"><option value="">Select...</option>{lookupData.commercialOfficeTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Min. Seats</label><input name="min_seats" type="number" min="0" value={commercialData.min_seats} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Max. Seats</label><input name="max_seats" type="number" min="0" value={commercialData.max_seats} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Private Cabins</label><input name="cabins" type="number" min="0" value={commercialData.cabins} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Meeting Rooms</label><input name="meeting_rooms" type="number" min="0" value={commercialData.meeting_rooms} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Private Washrooms</label><input name="private_washrooms" type="number" min="0" value={commercialData.private_washrooms} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                          <div><label className="block text-sm font-medium text-text-color-light mb-1">Shared Washrooms</label><input name="shared_washrooms" type="number" min="0" value={commercialData.shared_washrooms} onChange={createHandleChange(setCommercialData)} className="neumorphic-input"/></div>
                      </div>
                      <div className="pt-4 space-y-3">
                          <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="is_pre_leased" checked={commercialData.is_pre_leased} onChange={createHandleChange(setCommercialData)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is this property currently pre-leased?</label>
                          <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="has_noc" checked={commercialData.has_noc} onChange={createHandleChange(setCommercialData)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is your office NOC Certified?</label>
                          <label className="flex items-center gap-2 neumorphic-button !rounded-lg text-sm !p-3 cursor-pointer"><input type="checkbox" name="has_occupancy_cert" checked={commercialData.has_occupancy_cert} onChange={createHandleChange(setCommercialData)} className="h-4 w-4 shadow-neumorphic-inset appearance-none checked:bg-success-color rounded-sm"/>Is an Occupancy Certificate available?</label>
                      </div>
                  </div>
              </section>
            )}

            <section>
              <h2 className="text-xl font-semibold text-text-color-dark border-b border-shadow-dark/20 pb-2 mb-6">Manage Media</h2>
              <div className="p-4 shadow-neumorphic-inset rounded-2xl">
                 {existingImages.length > 0 && (
                    <div className="mb-4">
                      <p className="block text-sm font-medium text-text-color-light mb-2">Current Images:</p>
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4">
                        {existingImages.map((img) => (
                          <div key={img.id} className="relative aspect-square rounded-xl overflow-hidden group shadow-neumorphic-outset p-1">
                            <img src={img.media_url} alt={`Property image ${img.id}`} className="w-full h-full object-cover rounded-lg"/>
                            <button type="button" onClick={() => handleRemoveExistingImage(img.id)} className="absolute top-1 right-1 bg-danger-color text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200"><XCircle size={20} /></button>
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
                          <div key={img.id} className="relative aspect-square rounded-xl overflow-hidden group shadow-neumorphic-outset p-1">
                            <img src={img.preview} alt="New Preview" className="w-full h-full object-cover rounded-lg"/>
                            <button type="button" onClick={() => handleRemoveNewImage(img.id)} className="absolute top-1 right-1 bg-danger-color text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200"><Trash2 size={20} /></button>
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
