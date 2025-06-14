'use client';

import { useState, useEffect, FormEvent, ChangeEvent, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import imageCompression from 'browser-image-compression';
import parsePhoneNumber, { isValidPhoneNumber } from 'libphonenumber-js';
import { Loader2, UploadCloud } from 'lucide-react';
import dynamic from 'next/dynamic';

const LocationPicker = dynamic(() => import('@/app/components/LocationPicker'), {
  loading: () => (
    <div className="h-[288px] flex items-center justify-center shadow-neumorphic-inset rounded-2xl">
      <Loader2 className="animate-spin text-text-color-light" />
      <span className="ml-2 text-text-color-light">Loading Map...</span>
    </div>
  ),
  ssr: false
});

type BhkType = { id: number; label: string; };
type ListingType = { id: number; name: string; };
type PropertyType = { id: number; name: string; };

function AddPropertyPage() {
  const router = useRouter();
  // Reverting to individual state management to match your working code exactly
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [area, setArea] = useState('');
  const [locationText, setLocationText] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [selectedBhkTypeId, setSelectedBhkTypeId] = useState('');
  const [selectedListingTypeId, setSelectedListingTypeId] = useState('');
  const [selectedPropertyTypeId, setSelectedPropertyTypeId] = useState('');
  
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [images, setImages] = useState<FileList | null>(null);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [dropdownLoading, setDropdownLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [bhkTypesList, setBhkTypesList] = useState<BhkType[]>([]);
  const [listingTypesList, setListingTypesList] = useState<ListingType[]>([]);
  const [propertyTypesList, setPropertyTypesList] = useState<PropertyType[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      setDropdownLoading(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: profile } = await supabase.from('profiles').select('phone_number').eq('id', user.id).single();
          if (profile?.phone_number) setPhoneNumber(profile.phone_number);
        }
        const [bhkRes, listingRes, propertyTypeRes] = await Promise.all([
          supabase.from('bhk_types').select('id, label'),
          supabase.from('listing_types').select('id, name'),
          supabase.from('property_types').select('id, name')
        ]);
        if (bhkRes.error) throw bhkRes.error;
        setBhkTypesList(bhkRes.data || []);
        if (listingRes.error) throw listingRes.error;
        setListingTypesList(listingRes.data || []);
        if (propertyTypeRes.error) throw propertyTypeRes.error;
        setPropertyTypesList(propertyTypeRes.data || []);
      } catch (error: any) {
        setMessage({ type: 'error', text: `Error fetching initial data: ${error.message}` });
      } finally {
        setDropdownLoading(false);
      }
    };
    fetchData();
  }, []);

  const handleLocationChange = useCallback((lat: number, lng: number) => {
    setCoordinates({ lat, lng });
  }, []);

  const handleImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setImages(files);
      imagePreviews.forEach(url => URL.revokeObjectURL(url));
      setImagePreviews(Array.from(files).map(file => URL.createObjectURL(file)));
    } else {
      setImages(null);
      setImagePreviews([]);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setPhoneError(null);

    if (!isValidPhoneNumber(phoneNumber, 'IN')) {
        setPhoneError('A valid Indian phone number is required (e.g., +91**********).'); return;
    }
    const parsedPhoneNumber = parsePhoneNumber(phoneNumber, 'IN');
    if (!parsedPhoneNumber) {
        setPhoneError('Invalid phone number format.'); return;
    }
    if (!title || !description || !price || !area || !locationText || !coordinates ||
        !selectedBhkTypeId || !selectedListingTypeId || !selectedPropertyTypeId) {
      setMessage({ type: 'error', text: 'All fields are required. Please also select a location on the map.' }); return;
    }
    
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setMessage({ type: 'error', text: 'You must be signed in.' }); setLoading(false); return;
    }

    await supabase.from('profiles').upsert({ id: user.id, phone_number: parsedPhoneNumber.format('E.164') });

    // Correct property payload, now including lat/lng as your schema likely supports it
    const propertyPayload = {
      title, description, price: parseFloat(price),
      bhk_type_id: parseInt(selectedBhkTypeId),
      listing_type_id: parseInt(selectedListingTypeId),
      property_type_id: parseInt(selectedPropertyTypeId),
      area_sqft: parseFloat(area), location_text: locationText, user_id: user.id,
      latitude: coordinates.lat, longitude: coordinates.lng,
    };
    const { data: property, error: propertyError } = await supabase.from('properties').insert(propertyPayload).select('id').single();

    if (propertyError || !property) {
      setMessage({ type: 'error', text: `Error adding property: ${propertyError.message || 'Unknown error'}` });
      setLoading(false); return;
    }
    
    if (images && images.length > 0) {
      const imageUploadPromises = Array.from(images).map(async (file) => {
        const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1024, useWebWorker: true };
        const compressedFile = await imageCompression(file, options).catch(err => {
          console.warn(`Could not compress image ${file.name}. Uploading original.`, err);
          return file;
        });

        const fileExt = compressedFile.name.split('.').pop();
        const randomFileName = `${Date.now()}-${Math.random()}.${fileExt}`;
        const filePath = `${user.id}/${property.id}/${randomFileName}`;
        
        const { error: uploadError } = await supabase.storage.from('property-images').upload(filePath, compressedFile);
        if (uploadError) { throw new Error(`Upload failed for ${file.name}: ${uploadError.message}`); }
        
        const { data: publicUrlData } = supabase.storage.from('property-images').getPublicUrl(filePath);
        if (!publicUrlData?.publicUrl) { throw new Error(`Could not get public URL for ${filePath}`); }
        
        // --- FIX: This payload now matches your working code. It does NOT include user_id. ---
        return { property_id: property.id, image_url: publicUrlData.publicUrl };
      });

      const results = await Promise.allSettled(imageUploadPromises);
      const successfulUploads = results.filter(r => r.status === 'fulfilled' && r.value).map(r => (r as PromiseFulfilledResult<any>).value);
      
      if (successfulUploads.length > 0) {
        const { error: imageInsertError } = await supabase.from('property_images').insert(successfulUploads);
        if (imageInsertError) { 
          setMessage({ type: 'error', text: `Property added, but failed to save image records: ${imageInsertError.message}` });
        }
      }
    }

    if (!message) { setMessage({ type: 'success', text: 'Property added successfully! Redirecting...' }); }
    
    setTimeout(() => { router.push(`/property/${property.id}`); }, 2000);
    setLoading(false);
  };
  
  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <div className="max-w-3xl mx-auto my-8 p-6 sm:p-8 shadow-neumorphic-outset rounded-3xl">
        <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">Add New Property</h1>
        {message && (
          <div className={`p-4 mb-6 text-sm rounded-lg ${ message.type === 'error' ? 'bg-red-200 text-red-800' : 'bg-green-200 text-green-800' }`}>
            {message.text}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-8">
          <div>
            <label htmlFor="title" className="block text-sm font-medium text-text-color-light mb-1">Title</label>
            <input id="title" name="title" type="text" placeholder="e.g., Spacious 2BHK Apartment" value={title} onChange={(e) => setTitle(e.target.value)} required className="neumorphic-input"/>
          </div>
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-text-color-light mb-1">Description</label>
            <textarea id="description" name="description" rows={4} placeholder="Describe your property..." value={description} onChange={(e) => setDescription(e.target.value)} required className="neumorphic-input"/>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
            <div>
              <label htmlFor="price" className="block text-sm font-medium text-text-color-light mb-1">Price (in INR)</label>
              <input id="price" name="price" type="number" placeholder="e.g., 5000000" value={price} onChange={(e) => setPrice(e.target.value)} required className="neumorphic-input"/>
            </div>
            <div>
              <label htmlFor="area" className="block text-sm font-medium text-text-color-light mb-1">Area (in sq. ft.)</label>
              <input id="area" name="area" type="number" placeholder="e.g., 1200" value={area} onChange={(e) => setArea(e.target.value)} required className="neumorphic-input"/>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            <div>
              <label htmlFor="selectedBhkTypeId" className="block text-sm font-medium text-text-color-light mb-1">BHK Type</label>
              <select id="selectedBhkTypeId" name="selectedBhkTypeId" value={selectedBhkTypeId} onChange={(e) => setSelectedBhkTypeId(e.target.value)} required className="neumorphic-input">
                <option value="" disabled>Select BHK</option>
                {bhkTypesList.map(bhk => <option key={bhk.id} value={bhk.id}>{bhk.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="selectedListingTypeId" className="block text-sm font-medium text-text-color-light mb-1">Listing Type</label>
              <select id="selectedListingTypeId" name="selectedListingTypeId" value={selectedListingTypeId} onChange={(e) => setSelectedListingTypeId(e.target.value)} required className="neumorphic-input">
                <option value="" disabled>Select Listing</option>
                {listingTypesList.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="selectedPropertyTypeId" className="block text-sm font-medium text-text-color-light mb-1">Property Type</label>
              <select id="selectedPropertyTypeId" name="selectedPropertyTypeId" value={selectedPropertyTypeId} onChange={(e) => setSelectedPropertyTypeId(e.target.value)} required className="neumorphic-input">
                <option value="" disabled>Select Type</option>
                {propertyTypesList.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="phoneNumber" className="block text-sm font-medium text-text-color-light mb-1">Contact Phone Number</label>
            <input id="phoneNumber" name="phoneNumber" type="tel" placeholder="+91" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} required className="neumorphic-input"/>
            {phoneError && <p className="text-red-500 text-xs mt-1">{phoneError}</p>}
          </div>
          <div className="space-y-2">
            <label className="block text-lg font-semibold text-text-color-dark">Property Location</label>
            <LocationPicker onLocationChange={handleLocationChange} />
            <label htmlFor="locationText" className="block text-sm font-medium text-text-color-light mb-1 pt-4">Location Name / Area</label>
            <input id="locationText" name="locationText" type="text" placeholder="e.g., Hiranandani Gardens, Powai" value={locationText} onChange={(e) => setLocationText(e.target.value)} required className="neumorphic-input"/>
          </div>
          <div>
             <label className="block text-sm font-medium text-text-color-light mb-2">Property Images</label>
             <div className="relative neumorphic-input flex items-center justify-center p-0 h-32">
               <input type="file" id="images" multiple onChange={handleImageChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" accept="image/png, image/jpeg, image/webp"/>
               <div className="text-center pointer-events-none">
                 <UploadCloud className="mx-auto h-8 w-8 text-text-color-light" />
                 <p className="mt-1 text-sm text-text-color-dark">Click to upload images</p>
               </div>
             </div>
             {imagePreviews.length > 0 && (
               <div className="mt-4 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4">
                 {imagePreviews.map((url, index) => <img key={index} src={url} alt="Preview" className="h-24 w-full object-cover rounded-lg shadow-neumorphic-outset"/>)}
               </div>
             )}
          </div>
          <button type="submit" disabled={loading || dropdownLoading} className="w-full neumorphic-button bg-cta-gradient py-3 text-lg">
            {loading ? <Loader2 className="animate-spin inline-block mr-2" /> : null}
            {loading ? 'Submitting...' : 'Submit Property'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default withAuth(AddPropertyPage);