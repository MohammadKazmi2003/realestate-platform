'use client'

import { useState, useEffect, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import Header from '@/app/components/Header'
import { withAuth } from '@/utils/withAuth'

// Define types for the data we'll fetch for dropdowns
type BhkType = {
  id: number;
  label: string;
}

type ListingType = {
  id: number;
  name: string;
}

type PropertyType = {
  id: number;
  name: string;
}

function AddPropertyPage() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [selectedBhkTypeId, setSelectedBhkTypeId] = useState<string>('')
  const [selectedListingTypeId, setSelectedListingTypeId] = useState<string>('')
  const [selectedPropertyTypeId, setSelectedPropertyTypeId] = useState<string>('')
  const [area, setArea] = useState('')
  const [locationText, setLocationText] = useState('')
  const [images, setImages] = useState<FileList | null>(null)
  const [loading, setLoading] = useState(false) // For main form submission
  const [dropdownLoading, setDropdownLoading] = useState(false); // For fetching dropdown options
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [bhkTypesList, setBhkTypesList] = useState<BhkType[]>([])
  const [listingTypesList, setListingTypesList] = useState<ListingType[]>([])
  const [propertyTypesList, setPropertyTypesList] = useState<PropertyType[]>([])

  // >>>>>>>>> START OF useEffect WITH LOGS <<<<<<<<<<
  useEffect(() => {
    const fetchDataForDropdowns = async () => {
      // ----- LOG 1 -----
      console.log('AddPropertyPage: useEffect - Fetching dropdown data...');
      setDropdownLoading(true);
      try {
        const { data: bhkData, error: bhkError } = await supabase
          .from('bhk_types')
          .select('id, label');
        if (bhkError) {
          // ----- LOG 2 (Error Case) -----
          console.error('AddPropertyPage: useEffect - BHK Fetch Error:', bhkError);
          throw bhkError;
        }
        // ----- LOG 3 -----
        console.log('AddPropertyPage: useEffect - Fetched BHK Data:', bhkData);
        setBhkTypesList(bhkData || []);

        const { data: listingData, error: listingError } = await supabase
          .from('listing_types')
          .select('id, name');
        if (listingError) {
          // ----- LOG 4 (Error Case) -----
          console.error('AddPropertyPage: useEffect - Listing Type Fetch Error:', listingError);
          throw listingError;
        }
        // ----- LOG 5 -----
        console.log('AddPropertyPage: useEffect - Fetched Listing Type Data:', listingData);
        setListingTypesList(listingData || []);

        const { data: propertyTypeData, error: propertyTypeError } = await supabase
          .from('property_types')
          .select('id, name');
        if (propertyTypeError) {
          // ----- LOG 6 (Error Case) -----
          console.error('AddPropertyPage: useEffect - Property Type Fetch Error:', propertyTypeError);
          throw propertyTypeError;
        }
        // ----- LOG 7 -----
        console.log('AddPropertyPage: useEffect - Fetched Property Type Data:', propertyTypeData);
        setPropertyTypesList(propertyTypeData || []);

      } catch (error: any) {
        // ----- LOG 8 (Catch Block) -----
        console.error('AddPropertyPage: useEffect - Error in fetchDataForDropdowns catch block:', error);
        setMessage({ type: 'error', text: `Error fetching selection options: ${error.message}` });
      } finally {
        // ----- LOG 9 -----
        console.log('AddPropertyPage: useEffect - Finished fetching dropdown data.');
        setDropdownLoading(false);
      }
    };

    fetchDataForDropdowns();
  }, []);
  // >>>>>>>>> END OF useEffect WITH LOGS <<<<<<<<<<


  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null); 

    if (!title || !description || !price || !area || !locationText || 
        !selectedBhkTypeId || !selectedListingTypeId || !selectedPropertyTypeId) {
      setMessage({ type: 'error', text: 'All fields except images are required, including all type selections.' });
      return;
    }
    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setMessage({ type: 'error', text: 'Please sign in to add a property.' });
      setLoading(false);
      return;
    }

    const propertyPayload = {
      title, description, price: parseFloat(price),
      bhk_type_id: parseInt(selectedBhkTypeId),
      listing_type_id: parseInt(selectedListingTypeId),
      property_type_id: parseInt(selectedPropertyTypeId),
      area_sqft: parseFloat(area), location_text: locationText, user_id: user.id,
    };

    const { data: property, error: propertyError } = await supabase
      .from('properties')
      .insert(propertyPayload)
      .select('id') 
      .single();

    if (propertyError || !property) {
      console.error('AddPropertyPage: handleSubmit - Error inserting property:', propertyError);
      setMessage({ type: 'error', text: `Error adding property: ${propertyError?.message || 'Unknown error'}` });
      setLoading(false);
      return;
    }

    if (images && images.length > 0) {
      const imageUploadPromises = Array.from(images).map(async (file) => {
        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}-${Math.random()}.${fileExt}`;
        const filePath = `public/${property.id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('property-images')
          .upload(filePath, file);

        if (uploadError) {
          console.error(`AddPropertyPage: handleSubmit - Error uploading image ${file.name}:`, uploadError);
          throw new Error(`Failed to upload ${file.name}: ${uploadError.message}`); 
        }
        const { data: publicUrlData } = supabase.storage
          .from('property-images')
          .getPublicUrl(filePath);
        
        if (publicUrlData && publicUrlData.publicUrl) {
            return { property_id: property.id, image_url: publicUrlData.publicUrl };
        } else {
            console.error(`AddPropertyPage: handleSubmit - Could not get public URL for ${filePath}`);
            throw new Error(`Could not get public URL for ${filePath}`);
        }
      });

      try {
        const uploadedImageObjectsResults = await Promise.allSettled(imageUploadPromises);
        
        const successfulUploads = uploadedImageObjectsResults
            .filter(result => result.status === 'fulfilled' && result.value)
            .map(result => (result as PromiseFulfilledResult<any>).value);

        const failedUploads = uploadedImageObjectsResults
            .filter(result => result.status === 'rejected');

        if (failedUploads.length > 0) {
            const errorMessages = failedUploads.map(fail => (fail as PromiseRejectedResult).reason?.message || 'Unknown upload error').join(', ');
            setMessage({ type: 'error', text: `Property added, but some images failed to upload: ${errorMessages}` });
        }
        
        if (successfulUploads.length > 0) {
          const { error: imageInsertError } = await supabase
            .from('property_images')
            .insert(successfulUploads);

          if (imageInsertError) {
            console.error('AddPropertyPage: handleSubmit - Error inserting image URLs:', imageInsertError);
            const currentMessage = message?.text || 'Property added.';
            setMessage({ type: 'error', text: `${currentMessage} Error saving image records: ${imageInsertError.message}` });
          }
        }
      } catch (overallUploadError: any) { 
        console.error('AddPropertyPage: handleSubmit - Overall error during image processing:', overallUploadError);
        if (!message || message.type === 'success') {
             setMessage({ type: 'error', text: `Property added, but an issue occurred with image processing: ${overallUploadError.message}` });
        }
      }
    }

    setLoading(false);
    if (!message || message.type === 'success') { 
        setMessage({ type: 'success', text: 'Property added successfully! Redirecting...' });
    }

    setTimeout(() => {
      router.push(`/property/${property.id}`);
    }, message && message.type === 'error' ? 3000 : 1500);
  };

  // >>>>>>>>> START OF LOGS BEFORE RETURN <<<<<<<<<<
  // ----- LOG 10 -----
  console.log('AddPropertyPage: Render - bhkTypesList:', bhkTypesList);
  // ----- LOG 11 -----
  console.log('AddPropertyPage: Render - listingTypesList:', listingTypesList);
  // ----- LOG 12 -----
  console.log('AddPropertyPage: Render - propertyTypesList:', propertyTypesList);
  // ----- LOG 13 -----
  console.log('AddPropertyPage: Render - dropdownLoading state:', dropdownLoading);
  // ----- LOG 14 -----
  console.log('AddPropertyPage: Render - main form loading state:', loading);
  // >>>>>>>>> END OF LOGS BEFORE RETURN <<<<<<<<<<


  return (
    <>
      <Header />
      <div className="max-w-xl mx-auto mt-8 p-6 bg-white shadow-xl rounded-lg mb-8">
        <h1 className="text-3xl font-bold mb-6 text-center text-gray-700">Add New Property</h1>
        {message && (
          <div
            className={`p-4 mb-4 text-sm rounded-lg ${
              message.type === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
            }`}
            role="alert"
          >
            {message.text}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Form fields remain the same as the previous full code version */}
          {/* Title */}
          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700">Title</label>
            <input id="title" type="text" placeholder="Luxury Apartment with Sea View" value={title} onChange={(e) => setTitle(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
          </div>
          {/* Description */}
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700">Description</label>
            <textarea id="description" placeholder="A detailed description of the property..." value={description} onChange={(e) => setDescription(e.target.value)} required rows={4} className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
          </div>
          {/* Price and Area */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label htmlFor="price" className="block text-sm font-medium text-gray-700">Price (INR)</label>
              <input id="price" type="number" placeholder="5000000" value={price} onChange={(e) => setPrice(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
            </div>
            <div>
              <label htmlFor="area" className="block text-sm font-medium text-gray-700">Area (sqft)</label>
              <input id="area" type="number" placeholder="1200" value={area} onChange={(e) => setArea(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
            </div>
          </div>
          {/* Location Text */}
          <div>
            <label htmlFor="locationText" className="block text-sm font-medium text-gray-700">Location Description</label>
            <input id="locationText" type="text" placeholder="e.g., Near City Mall, Main Street, Anytown" value={locationText} onChange={(e) => setLocationText(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
          </div>
          {/* BHK Type Dropdown */}
          <div>
            <label htmlFor="bhkTypeId" className="block text-sm font-medium text-gray-700">BHK Type</label>
            <select id="bhkTypeId" value={selectedBhkTypeId} onChange={(e) => setSelectedBhkTypeId(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white" disabled={dropdownLoading || bhkTypesList.length === 0}>
              <option value="" disabled>Select BHK Type</option>
              {bhkTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.label}</option>))}
            </select>
          </div>
          {/* Listing Type Dropdown */}
          <div>
            <label htmlFor="listingTypeId" className="block text-sm font-medium text-gray-700">Listing Type</label>
            <select id="listingTypeId" value={selectedListingTypeId} onChange={(e) => setSelectedListingTypeId(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white" disabled={dropdownLoading || listingTypesList.length === 0}>
              <option value="" disabled>Select Listing Type</option>
              {listingTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.name}</option>))}
            </select>
          </div>
          {/* Property Type Dropdown */}
          <div>
            <label htmlFor="propertyTypeId" className="block text-sm font-medium text-gray-700">Property Type</label>
            <select id="propertyTypeId" value={selectedPropertyTypeId} onChange={(e) => setSelectedPropertyTypeId(e.target.value)} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white" disabled={dropdownLoading || propertyTypesList.length === 0}>
              <option value="" disabled>Select Property Type</option>
              {propertyTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.name}</option>))}
            </select>
          </div>
          {/* Images Input */}
          <div>
            <label htmlFor="images" className="block text-sm font-medium text-gray-700">Property Images</label>
            <input id="images" type="file" multiple accept="image/*" onChange={(e) => setImages(e.target.files)} className="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"/>
          </div>
          {/* Submit Button */}
          <button type="submit" disabled={loading || dropdownLoading} className={`w-full text-white px-4 py-3 rounded-md font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 ${(loading || dropdownLoading) ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500'}`}>
            {(loading || dropdownLoading) ? 'Loading Options...' : (loading ? 'Submitting...' : 'Submit Property')}
          </button>
        </form>
      </div>
    </>
  )
}

export default withAuth(AddPropertyPage);