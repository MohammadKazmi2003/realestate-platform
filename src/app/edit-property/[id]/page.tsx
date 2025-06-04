// src/app/edit-property/[id]/page.tsx
'use client';

import React, { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient'; // Import browser Supabase client
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import imageCompression from 'browser-image-compression';
import { XCircle } from 'lucide-react';
import { updatePropertyAndManageImages } from '@/lib/actions';
import { unstable_noStore as noStore } from 'next/cache';

// Define types (remains the same)
type BhkType = { id: number; label: string; };
type ListingType = { id: number; name: string; };
type PropertyType = { id: number; name: string; };

type ExistingImage = {
  id: number;
  image_url: string; // This will be the cache-busted URL for rendering
  file_path: string;
};

type NewImageFile = {
  file: File;
  preview: string;
  id: string;
};

type PropertyFormData = {
  title: string;
  description: string;
  price: string;
  bhk_type_id: string;
  listing_type_id: string;
  property_type_id: string;
  area_sqft: string;
  location_text: string;
};

interface EditPropertyPageProps {
  params: { id: string };
}

function EditPropertyPage({ params: paramsPromise }: EditPropertyPageProps) {
  noStore();

  const params = React.use(paramsPromise);
  const { id: propertyId } = params;
  const router = useRouter();

  const [formData, setFormData] = useState<PropertyFormData>({
    title: '', description: '', price: '', bhk_type_id: '',
    listing_type_id: '', property_type_id: '', area_sqft: '', location_text: '',
  });
  const [existingImages, setExistingImages] = useState<ExistingImage[]>([]);
  const [newImages, setNewImages] = useState<NewImageFile[]>([]);
  const [imagesToDelete, setImagesToDelete] = useState<ExistingImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [dropdownLoading, setDropdownLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [bhkTypesList, setBhkTypesList] = useState<BhkType[]>([]);
  const [listingTypesList, setListingTypesList] = useState<ListingType[]>([]);
  const [propertyTypesList, setPropertyTypesList] = useState<PropertyType[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setMessage(null);
      try {
        setDropdownLoading(true);
        const [
          { data: bhkData, error: bhkError },
          { data: listingData, error: listingError },
          { data: propertyTypeData, error: propertyTypeError }
        ] = await Promise.all([
          supabase.from('bhk_types').select('id, label'),
          supabase.from('listing_types').select('id, name'),
          supabase.from('property_types').select('id, name'),
        ]);

        if (bhkError) throw bhkError;
        if (listingError) throw listingError;
        if (propertyTypeError) throw propertyTypeError;

        setBhkTypesList(bhkData || []);
        setListingTypesList(listingData || []);
        setPropertyTypesList(propertyTypeData || []);
        setDropdownLoading(false);

        const { data: propertyFullData, error: propertyError } = await supabase
          .from('properties')
          .select(`
            title, description, price, area_sqft, location_text,
            bhk_type_id, listing_type_id, property_type_id, user_id,
            property_images ( id, image_url )
          `)
          .eq('id', propertyId)
          .single();

        if (propertyError || !propertyFullData) {
          throw new Error(propertyError?.message || 'Property not found or data is null.');
        }
        
        const { data: { user } } = await supabase.auth.getUser();
        if (!user || user.id !== propertyFullData.user_id) {
          setMessage({ type: 'error', text: 'You are not authorized to edit this property.' });
          setLoading(false);
          router.replace('/my-listings');
          return;
        }

        setFormData({
          title: propertyFullData.title || '',
          description: propertyFullData.description || '',
          price: propertyFullData.price?.toString() || '',
          bhk_type_id: propertyFullData.bhk_type_id?.toString() || '',
          listing_type_id: propertyFullData.listing_type_id?.toString() || '',
          property_type_id: propertyFullData.property_type_id?.toString() || '',
          area_sqft: propertyFullData.area_sqft?.toString() || '',
          location_text: propertyFullData.location_text || '',
        });

        const rawImagesFromDb = propertyFullData.property_images as { id: number; image_url: string; }[] || [];
        
        // Client-side validation of images
        const validatedImages = await Promise.all(
          rawImagesFromDb.map(async (img) => {
            if (!img.image_url) return null;

            const originalUrl = img.image_url;
            let headCheckUrlStr = originalUrl;

            try {
              const headCheckUrl = new URL(originalUrl);
              headCheckUrl.searchParams.set('check_ts', Date.now().toString()); // Cache-buster for HEAD request
              headCheckUrlStr = headCheckUrl.toString();

              const response = await fetch(headCheckUrlStr, { method: 'HEAD', cache: 'no-store' });
              if (response.ok) {
                const pathSegments = originalUrl.split('property-images/');
                const filePathInStorage = pathSegments && pathSegments.length > 1 ? pathSegments[1] : '';
                
                // Create a new URL object for rendering to add a render-specific cache-buster
                const renderUrl = new URL(originalUrl);
                renderUrl.searchParams.set('render_ts', Date.now().toString());

                return { 
                  id: img.id, 
                  image_url: renderUrl.toString(), // Cache-busted URL for <img src>
                  file_path: filePathInStorage 
                };
              } else {
                console.warn(`Client-side HEAD check failed for ${originalUrl}, status: ${response.status}`);
                return null;
              }
            } catch (e) {
              console.error(`Client-side HEAD check error for ${originalUrl}:`, e);
              return null;
            }
          })
        );

        const finalImagesToDisplay = validatedImages.filter(Boolean) as ExistingImage[];
        console.log("Final validated existing images to display on edit page:", finalImagesToDisplay);
        setExistingImages(finalImagesToDisplay);

      } catch (error: any) {
        console.error("Error fetching data for edit page:", error);
        setMessage({ type: 'error', text: `Failed to load property or options: ${error.message}` });
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [propertyId, router]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleNewImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach(file => {
        const previewUrl = URL.createObjectURL(file);
        setNewImages(prev => [
          ...prev,
          { id: Math.random().toString(36).substring(2, 9), file, preview: previewUrl },
        ]);
      });
      e.target.value = '';
    }
  };

  const handleRemoveNewImage = (id: string) => {
    setNewImages(prev => prev.filter(img => img.id !== id));
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
    setMessage(null);
    if (!formData.title || !formData.description || !formData.price || !formData.area_sqft || !formData.location_text ||
        !formData.bhk_type_id || !formData.listing_type_id || !formData.property_type_id) {
      setMessage({ type: 'error', text: 'All fields are required.' });
      return;
    }
    setIsSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated.');

      const newImageDbEntries = await Promise.all(
        newImages.map(async (newImg) => {
          const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1024, useWebWorker: true };
          let fileToUpload = newImg.file;
          try {
            fileToUpload = await imageCompression(newImg.file, options);
          } catch (compressionError) {
            console.warn(`Could not compress image ${newImg.file.name}. Uploading original.`, compressionError);
          }
          const fileExt = fileToUpload.name.split('.').pop();
          const fileNameInStorage = `${Date.now()}-${Math.random()}.${fileExt}`;
          const filePath = `${user.id}/${propertyId}/${fileNameInStorage}`;
          const { error: uploadError } = await supabase.storage.from('property-images').upload(filePath, fileToUpload);
          if (uploadError) throw new Error(`Failed to upload ${newImg.file.name}: ${uploadError.message}`);
          const { data: publicUrlData } = supabase.storage.from('property-images').getPublicUrl(filePath);
          if (!publicUrlData?.publicUrl) throw new Error(`Could not get public URL for ${filePath}`);
          return { property_id: propertyId, image_url: publicUrlData.publicUrl };
        })
      );

      const propertyUpdatePayload = {
        title: formData.title, description: formData.description, price: parseFloat(formData.price),
        bhk_type_id: parseInt(formData.bhk_type_id), listing_type_id: parseInt(formData.listing_type_id),
        property_type_id: parseInt(formData.property_type_id), area_sqft: parseFloat(formData.area_sqft),
        location_text: formData.location_text,
      };
      const imagePathsToDelete = imagesToDelete.map(img => img.file_path).filter(Boolean); // Ensure no empty paths
      const imageIdsToDelete = imagesToDelete.map(img => img.id);

      const result = await updatePropertyAndManageImages(
        propertyId, user.id, propertyUpdatePayload,
        imagePathsToDelete, imageIdsToDelete, newImageDbEntries,
      );
      if (!result.success) throw new Error(result.message);

      setMessage({ type: 'success', text: result.message + ' Redirecting...' });
      const timestamp = Date.now();
      window.location.href = `/property/${propertyId}?v=${timestamp}`;
    } catch (error: any) {
      console.error("Error during property update:", error);
      setMessage({ type: 'error', text: `Update failed: ${error.message}` });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) { /* Loading UI */ }
  if (!loading && !formData.title && !message) { /* Not found/authorized UI */ }

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto mt-8 p-6 bg-white shadow-xl rounded-lg mb-8">
        <h1 className="text-3xl font-bold mb-6 text-center text-gray-700">Edit Property</h1>
        {message && (
          <div className={`p-4 mb-4 text-sm rounded-lg ${message.type === 'error' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`} role="alert">
            {message.text}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Form fields (title, description, price, etc. - unchanged) */}
          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700">Title</label>
            <input id="title" type="text" name="title" placeholder="Luxury Apartment with Sea View" value={formData.title} onChange={handleChange} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
          </div>
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700">Description</label>
            <textarea id="description" name="description" placeholder="A detailed description of the property..." value={formData.description} onChange={handleChange} required rows={4} className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label htmlFor="price" className="block text-sm font-medium text-gray-700">Price (INR)</label>
              <input id="price" type="number" name="price" placeholder="5000000" value={formData.price} onChange={handleChange} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
            </div>
            <div>
              <label htmlFor="area_sqft" className="block text-sm font-medium text-gray-700">Area (sqft)</label>
              <input id="area_sqft" type="number" name="area_sqft" placeholder="1200" value={formData.area_sqft} onChange={handleChange} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
            </div>
          </div>
          <div>
            <label htmlFor="locationText" className="block text-sm font-medium text-gray-700">Location Description</label>
            <input id="locationText" type="text" name="location_text" placeholder="e.g., Near City Mall, Main Street, Anytown" value={formData.location_text} onChange={handleChange} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500"/>
          </div>
          <div>
            <label htmlFor="bhkTypeId" className="block text-sm font-medium text-gray-700">BHK Type</label>
            <select id="bhkTypeId" name="bhk_type_id" value={formData.bhk_type_id} onChange={handleChange} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white" disabled={dropdownLoading || bhkTypesList.length === 0 || loading}>
              <option value="" disabled>Select BHK Type</option>
              {bhkTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.label}</option>))}
            </select>
          </div>
          <div>
            <label htmlFor="listingTypeId" className="block text-sm font-medium text-gray-700">Listing Type</label>
            <select id="listingTypeId" name="listing_type_id" value={formData.listing_type_id} onChange={handleChange} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white" disabled={dropdownLoading || listingTypesList.length === 0 || loading}>
              <option value="" disabled>Select Listing Type</option>
              {listingTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.name}</option>))}
            </select>
          </div>
          <div>
            <label htmlFor="propertyTypeId" className="block text-sm font-medium text-gray-700">Property Type</label>
            <select id="propertyTypeId" name="property_type_id" value={formData.property_type_id} onChange={handleChange} required className="mt-1 w-full border p-3 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white" disabled={dropdownLoading || propertyTypesList.length === 0 || loading}>
              <option value="" disabled>Select Property Type</option>
              {propertyTypesList.map((type) => (<option key={type.id} value={type.id.toString()}>{type.name}</option>))}
            </select>
          </div>

          {/* Image Management Section */}
          <div className="border-t pt-6 mt-6">
            <h3 className="text-xl font-semibold mb-4 text-gray-700">Manage Images</h3>
            {existingImages.length > 0 && (
              <div className="mb-4">
                <p className="block text-sm font-medium text-gray-700 mb-2">Current Images:</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {existingImages.map((img) => (
                    <div key={img.id} className="relative aspect-video rounded-md overflow-hidden group">
                      <img
                        src={img.image_url} // This URL is now cache-busted and pre-validated
                        alt={`Property image ${img.id}`}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          // Fallback if an image that passed HEAD check still fails to load (e.g. transient network)
                          console.warn('Hiding image due to secondary load error:', e.currentTarget.src);
                          const parentElement = e.currentTarget.closest('.relative.aspect-video');
                          if (parentElement) {
                            (parentElement as HTMLElement).style.display = 'none';
                          } else {
                            e.currentTarget.style.display = 'none';
                          }
                          e.currentTarget.onerror = null; 
                        }}
                      />
                      <button type="button" onClick={() => handleRemoveExistingImage(img.id)}
                        className="absolute top-1 right-1 bg-red-600 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                        title="Remove image">
                        <XCircle size={20} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(existingImages.length === 0 && newImages.length === 0 && !loading) && (
              <p className="text-gray-500 italic mb-4">No images currently associated with this property.</p>
            )}
            {/* New Images Input & Previews (unchanged) */}
             <div>
              <label htmlFor="newImages" className="block text-sm font-medium text-gray-700">Upload New Images</label>
              <input
                id="newImages"
                type="file"
                multiple
                accept="image/*"
                onChange={handleNewImageChange}
                className="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
              />
            </div>
            {newImages.length > 0 && (
              <div className="mt-4">
                <p className="block text-sm font-medium text-gray-700 mb-2">New Images to Upload:</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {newImages.map((img) => (
                    <div key={img.id} className="relative aspect-video rounded-md overflow-hidden group">
                      <img src={img.preview} alt="New Property Image Preview" className="w-full h-full object-cover"/>
                      <button type="button" onClick={() => handleRemoveNewImage(img.id)}
                        className="absolute top-1 right-1 bg-red-600 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                        title="Cancel upload">
                        <XCircle size={20} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button type="submit" disabled={isSubmitting || loading || dropdownLoading} className={`w-full text-white px-4 py-3 rounded-md font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 ${(isSubmitting || loading || dropdownLoading) ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500'}`}>
            {(isSubmitting) ? 'Updating...' : 'Update Property'}
          </button>
        </form>
      </div>
    </>
  );
}
export default withAuth(EditPropertyPage);
