// src/app/add-property/page.tsx
'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import imageCompression from 'browser-image-compression';
import parsePhoneNumber, { isValidPhoneNumber } from 'libphonenumber-js';
import LocationPicker from '@/app/components/LocationPicker';

// Type definitions
type BhkType = { id: number; label: string; };
type ListingType = { id: number; name: string; };
type PropertyType = { id: number; name: string; };

function AddPropertyPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [selectedBhkTypeId, setSelectedBhkTypeId] = useState<string>('');
  const [selectedListingTypeId, setSelectedListingTypeId] = useState<string>('');
  const [selectedPropertyTypeId, setSelectedPropertyTypeId] = useState<string>('');
  const [area, setArea] = useState('');
  const [locationText, setLocationText] = useState('');
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [images, setImages] = useState<FileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [dropdownLoading, setDropdownLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [bhkTypesList, setBhkTypesList] = useState<BhkType[]>([]);
  const [listingTypesList, setListingTypesList] = useState<ListingType[]>([]);
  const [propertyTypesList, setPropertyTypesList] = useState<PropertyType[]>([]);

  useEffect(() => {
    // This useEffect fetches initial data and remains unchanged
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
  
  const handleLocationChange = (lat: number, lng: number) => {
    setCoordinates({ lat, lng });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setPhoneError(null);

    // --- All Validations ---
    if (!phoneNumber || !isValidPhoneNumber(phoneNumber)) {
        setPhoneError('A valid phone number with country code is required.'); return;
    }
    const parsedPhoneNumber = parsePhoneNumber(phoneNumber);
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

    // --- Profile Update ---
    const { error: profileError } = await supabase.from('profiles').upsert({ id: user.id, phone_number: parsedPhoneNumber.format('E.164') });
    if (profileError) {
      setMessage({ type: 'error', text: `Failed to save phone number: ${profileError.message}` }); setLoading(false); return;
    }

    // --- Property Insertion ---
    const propertyPayload = {
      title, description, price: parseFloat(price),
      bhk_type_id: parseInt(selectedBhkTypeId), listing_type_id: parseInt(selectedListingTypeId),
      property_type_id: parseInt(selectedPropertyTypeId), area_sqft: parseFloat(area),
      location_text: locationText, user_id: user.id, latitude: coordinates.lat, longitude: coordinates.lng,
    };
    const { data: property, error: propertyError } = await supabase.from('properties').insert(propertyPayload).select('id').single();

    if (propertyError || !property) {
      setMessage({ type: 'error', text: `Error adding property: ${propertyError.message || 'Unknown error'}` }); setLoading(false); return;
    }

    // --- COMPLETE IMAGE UPLOAD LOGIC ---
    if (images && images.length > 0) {
      const imageUploadPromises = Array.from(images).map(async (file) => {
        const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1024, useWebWorker: true };
        const compressedFile = await imageCompression(file, options).catch((error) => {
            console.error('Image compression failed, using original file.', error);
            return file; // Fallback to original file on compression error
        });

        const filePath = `${user.id}/${property.id}/${Date.now()}-${file.name}`;
        
        const { error: uploadError } = await supabase.storage.from('property-images').upload(filePath, compressedFile);
        if (uploadError) {
            console.error('Supabase upload error:', uploadError);
            throw new Error(`Failed to upload ${file.name}: ${uploadError.message}`);
        }
        
        const { data: publicUrlData } = supabase.storage.from('property-images').getPublicUrl(filePath);
        if (!publicUrlData?.publicUrl) {
            throw new Error(`Could not get public URL for ${filePath}`);
        }
        
        return { property_id: property.id, image_url: publicUrlData.publicUrl };
      });

      const results = await Promise.allSettled(imageUploadPromises);
      const successfulUploads = results
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<any>).value);
      
      if (successfulUploads.length > 0) {
        const { error: imageInsertError } = await supabase.from('property_images').insert(successfulUploads);
        if (imageInsertError) {
          setMessage({ type: 'error', text: `Property added, but failed to save image records: ${imageInsertError.message}` });
        }
      }

      const failedUploads = results.filter(r => r.status === 'rejected');
      if (failedUploads.length > 0) {
          console.error("Some images failed to upload:", failedUploads);
          // Optionally update message to reflect partial success
      }
    }

    setMessage({ type: 'success', text: 'Property added successfully! Redirecting...' });
    setTimeout(() => router.push(`/property/${property.id}`), 1500);
    setLoading(false);
  };

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto mt-8 p-6 bg-white shadow-xl rounded-lg mb-8">
        <h1 className="text-3xl font-bold mb-6 text-center text-gray-700">Add New Property</h1>
        {message && (
          <div className={`p-4 mb-4 text-sm rounded-lg ${ message.type === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700' }`}>
            {message.text}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-8">
          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700">Property Title</label>
            <input id="title" type="text" placeholder="e.g., 2BHK Sea View Apartment" value={title} onChange={(e) => setTitle(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm"/>
          </div>
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700">Description</label>
            <textarea id="description" placeholder="A detailed description of the property..." value={description} onChange={(e) => setDescription(e.target.value)} required rows={4} className="mt-1 w-full border p-3 rounded-md shadow-sm"/>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label htmlFor="price" className="block text-sm font-medium text-gray-700">Price (INR)</label>
              <input id="price" type="number" placeholder="5000000" value={price} onChange={(e) => setPrice(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm"/>
            </div>
            <div>
              <label htmlFor="area" className="block text-sm font-medium text-gray-700">Area (sqft)</label>
              <input id="area" type="number" placeholder="1200" value={area} onChange={(e) => setArea(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm"/>
            </div>
          </div>
          <div>
            <label className="block text-lg font-semibold text-gray-800">Set Property Location</label>
            <LocationPicker onLocationChange={handleLocationChange} />
          </div>
          <div>
            <label htmlFor="locationText" className="block text-sm font-medium text-gray-700">Location Name / Area</label>
            <input id="locationText" type="text" placeholder="e.g., Hiranandani Gardens, Powai" value={locationText} onChange={(e) => setLocationText(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm"/>
          </div>
          <div>
            <label htmlFor="phoneNumber" className="block text-sm font-medium text-gray-700">Your Contact Number</label>
            <input id="phoneNumber" type="tel" placeholder="+91 12345 67890" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} required className={`mt-1 w-full border p-3 rounded-md shadow-sm ${phoneError ? 'border-red-500' : 'border-gray-300'}`} />
            {phoneError && <p className="mt-1 text-xs text-red-600">{phoneError}</p>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="bhkTypeId" className="block text-sm font-medium text-gray-700">BHK Type</label>
              <select id="bhkTypeId" value={selectedBhkTypeId} onChange={(e) => setSelectedBhkTypeId(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm bg-white" disabled={dropdownLoading}>
                <option value="" disabled>Select...</option>
                {bhkTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.label}</option>))}
              </select>
            </div>
            <div>
              <label htmlFor="listingTypeId" className="block text-sm font-medium text-gray-700">Listing Type</label>
              <select id="listingTypeId" value={selectedListingTypeId} onChange={(e) => setSelectedListingTypeId(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm bg-white" disabled={dropdownLoading}>
                <option value="" disabled>Select...</option>
                {listingTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.name}</option>))}
              </select>
            </div>
            <div>
              <label htmlFor="propertyTypeId" className="block text-sm font-medium text-gray-700">Property Type</label>
              <select id="propertyTypeId" value={selectedPropertyTypeId} onChange={(e) => setSelectedPropertyTypeId(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm bg-white" disabled={dropdownLoading}>
                <option value="" disabled>Select...</option>
                {propertyTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.name}</option>))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="images" className="block text-sm font-medium text-gray-700">Property Images</label>
            <input id="images" type="file" multiple accept="image/*" onChange={(e) => setImages(e.target.files)} className="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"/>
          </div>
          <button type="submit" disabled={loading || dropdownLoading} className="w-full text-white px-4 py-3 rounded-md font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400">
            {loading ? 'Submitting...' : 'Submit Property'}
          </button>
        </form>
      </div>
    </>
  );
}

export default withAuth(AddPropertyPage);
