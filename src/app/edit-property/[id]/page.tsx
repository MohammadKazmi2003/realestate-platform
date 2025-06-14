'use client';

// Import React.use to handle the params promise
import React, { useState, useEffect, FormEvent, ChangeEvent, use } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import imageCompression from 'browser-image-compression';
import { XCircle, Loader2, UploadCloud } from 'lucide-react';
import { updatePropertyAndManageImages } from '@/lib/actions';
import { unstable_noStore as noStore } from 'next/cache';

// Type definitions
type BhkType = { id: number; label: string; };
type ListingType = { id: number; name: string; };
type PropertyType = { id: number; name: string; };
type ExistingImage = { id: number; image_url: string; file_path: string; };
type NewImageFile = { file: File; preview: string; id: string; };
type PropertyFormData = {
  title: string; description: string; price: string; bhk_type_id: string;
  listing_type_id: string; property_type_id: string; area_sqft: string; location_text: string;
};

interface EditPropertyPageProps {
  // The 'params' prop is now a Promise-like object
  params: Promise<{ id: string }>;
}

function EditPropertyPage({ params: paramsPromise }: EditPropertyPageProps) {
  noStore();
  // **THE FIX**: Unwrap the promise using React.use()
  const params = use(paramsPromise);
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
            
            const validatedImages = await Promise.all(
              rawImagesFromDb.map(async (img) => {
                  if (!img.image_url) return null;
                  try {
                      const response = await fetch(img.image_url, { method: 'HEAD', cache: 'no-store' });
                      if (response.ok) {
                          const pathSegments = img.image_url.split('property-images/');
                          const filePathInStorage = pathSegments.length > 1 ? pathSegments[1] : '';
                          return { id: img.id, image_url: img.image_url, file_path: filePathInStorage };
                      }
                      return null;
                  } catch { return null; }
              })
            );

            setExistingImages(validatedImages.filter(Boolean) as ExistingImage[]);
        } catch (error: any) {
            console.error("Error fetching data for edit page:", error);
            setMessage({ type: 'error', text: `Failed to load property or options: ${error.message}` });
        } finally {
            setLoading(false);
        }
    };
    if (propertyId) {
        fetchData();
    }
  }, [propertyId, router]);
  
  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleNewImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const newImageFiles = Array.from(files).map(file => ({
        id: Math.random().toString(36).substring(2, 9),
        file,
        preview: URL.createObjectURL(file),
      }));
      setNewImages(prev => [...prev, ...newImageFiles]);
      e.target.value = ''; // Reset file input
    }
  };
  
  const handleRemoveNewImage = (id: string) => setNewImages(prev => prev.filter(img => img.id !== id));
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
    if (!formData.title || !formData.price || !formData.area_sqft) {
      setMessage({ type: 'error', text: 'Title, Price, and Area are required.' });
      return;
    }
    setIsSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated.');

      const newImageDbEntries = await Promise.all(
        newImages.map(async (newImg) => {
          const options = { maxSizeMB: 0.5, maxWidthOrHeight: 1024, useWebWorker: true };
          let fileToUpload = await imageCompression(newImg.file, options).catch(() => newImg.file);
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
      const imagePathsToDelete = imagesToDelete.map(img => img.file_path).filter(Boolean);
      const imageIdsToDelete = imagesToDelete.map(img => img.id);

      const result = await updatePropertyAndManageImages(
        propertyId, user.id, propertyUpdatePayload,
        imagePathsToDelete, imageIdsToDelete, newImageDbEntries,
      );
      if (!result.success) throw new Error(result.message);

      setMessage({ type: 'success', text: result.message + ' Redirecting...' });
      setTimeout(() => router.push(`/property/${propertyId}`), 1500);

    } catch (error: any) {
      console.error("Error during property update:", error);
      setMessage({ type: 'error', text: `Update failed: ${error.message}` });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
       <div className="max-w-3xl mx-auto my-8 p-6 sm:p-8 shadow-neumorphic-outset rounded-3xl">
        <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">Edit Property</h1>
        {loading && <div className="flex justify-center py-10"><Loader2 className="h-8 w-8 animate-spin text-text-color-light" /></div>}
        
        {message && (
          <div className={`p-4 mb-6 text-sm rounded-lg ${ message.type === 'error' ? 'bg-red-200 text-red-800' : 'bg-green-200 text-green-800' }`}>
            {message.text}
          </div>
        )}

        {!loading && formData.title && (
          <form onSubmit={handleSubmit} className="space-y-8">
            {/* Form fields with neumorphic styling */}
            <div>
              <label htmlFor="title" className="block text-sm font-medium text-text-color-light mb-1">Title</label>
              <input id="title" type="text" name="title" value={formData.title} onChange={handleChange} required className="neumorphic-input"/>
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-text-color-light mb-1">Description</label>
              <textarea id="description" name="description" value={formData.description} onChange={handleChange} required rows={4} className="neumorphic-input"/>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label htmlFor="price" className="block text-sm font-medium text-text-color-light mb-1">Price (INR)</label>
                <input id="price" type="number" name="price" value={formData.price} onChange={handleChange} required className="neumorphic-input"/>
              </div>
              <div>
                <label htmlFor="area_sqft" className="block text-sm font-medium text-text-color-light mb-1">Area (sqft)</label>
                <input id="area_sqft" type="number" name="area_sqft" value={formData.area_sqft} onChange={handleChange} required className="neumorphic-input"/>
              </div>
            </div>
            <div>
              <label htmlFor="locationText" className="block text-sm font-medium text-text-color-light mb-1">Location Description</label>
              <input id="locationText" type="text" name="location_text" value={formData.location_text} onChange={handleChange} required className="neumorphic-input"/>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="bhk_type_id" className="block text-sm font-medium text-text-color-light mb-1">BHK Type</label>
                <select id="bhk_type_id" name="bhk_type_id" value={formData.bhk_type_id} onChange={handleChange} required className="neumorphic-input w-full">
                  {bhkTypesList.map((type) => (<option key={type.id} value={type.id}>{type.label}</option>))}
                </select>
              </div>
              <div>
                <label htmlFor="listing_type_id" className="block text-sm font-medium text-text-color-light mb-1">Listing Type</label>
                <select id="listing_type_id" name="listing_type_id" value={formData.listing_type_id} onChange={handleChange} required className="neumorphic-input w-full">
                  {listingTypesList.map((type) => (<option key={type.id} value={type.id}>{type.name}</option>))}
                </select>
              </div>
              <div>
                <label htmlFor="property_type_id" className="block text-sm font-medium text-text-color-light mb-1">Property Type</label>
                <select id="property_type_id" name="property_type_id" value={formData.property_type_id} onChange={handleChange} required className="neumorphic-input w-full">
                  {propertyTypesList.map((type) => (<option key={type.id} value={type.id}>{type.name}</option>))}
                </select>
              </div>
            </div>

            <div className="border-t border-shadow-dark/20 pt-6 mt-6">
              <h3 className="text-xl font-semibold mb-4 text-text-color-dark">Manage Images</h3>
              {existingImages.length > 0 && (
                <div className="mb-4">
                  <p className="block text-sm font-medium text-text-color-light mb-2">Current Images:</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    {existingImages.map((img) => (
                      <div key={img.id} className="relative aspect-square rounded-xl overflow-hidden group shadow-neumorphic-outset p-1">
                        <img src={img.image_url} alt={`Property image ${img.id}`} className="w-full h-full object-cover rounded-lg"/>
                        <button type="button" onClick={() => handleRemoveExistingImage(img.id)}
                          className="absolute top-1 right-1 bg-danger-color text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <XCircle size={20} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              <label htmlFor="newImages" className="neumorphic-button w-full flex flex-col items-center justify-center p-6 cursor-pointer mt-4">
                <UploadCloud className="w-8 h-8 text-text-color-light mb-2"/>
                <span className="text-text-color-dark">Upload New Images</span>
              </label>
              <input id="newImages" type="file" multiple accept="image/*" onChange={handleNewImageChange} className="hidden"/>
               {newImages.length > 0 && (
                <div className="mt-4">
                  <p className="block text-sm font-medium text-text-color-light mb-2">New Images to Upload:</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    {newImages.map((img) => (
                      <div key={img.id} className="relative aspect-square rounded-xl overflow-hidden group shadow-neumorphic-outset p-1">
                        <img src={img.preview} alt="New Preview" className="w-full h-full object-cover rounded-lg"/>
                        <button type="button" onClick={() => handleRemoveNewImage(img.id)}
                          className="absolute top-1 right-1 bg-danger-color text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          <XCircle size={20} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button type="submit" disabled={isSubmitting || loading} className="w-full neumorphic-button bg-cta-gradient py-3 text-lg">
              {isSubmitting ? <Loader2 className="animate-spin inline-block mr-2" /> : null}
              {isSubmitting ? 'Updating...' : 'Update Property'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
export default withAuth(EditPropertyPage);
