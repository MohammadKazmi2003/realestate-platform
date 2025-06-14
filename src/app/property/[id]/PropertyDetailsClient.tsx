'use client';

import { useEffect, useState, useCallback } from 'react';
import type { FlattenedProperty, ImageType } from './page';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from '@/components/ui/carousel';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import { WhatsAppButton } from '@/app/components/WhatsAppButton';
import { FullScreenImageViewer } from '@/app/components/FullScreenImageViewer';
import { FaWhatsapp, FaBed, FaRulerCombined } from 'react-icons/fa';
import { Heart, Building, Tag, MapPin, Calendar, Loader2 } from 'lucide-react';

type Props = {
  property: FlattenedProperty | null;
  images: ImageType[];
  ownerPhone: string | null;
};

export default function PropertyDetailClient({ property, images, ownerPhone }: Props) {
  const [displayDate, setDisplayDate] = useState<string>('');
  const { user } = useAuth();
  const router = useRouter();

  const [isFavorited, setIsFavorited] = useState<boolean>(false);
  const [isFavoriteLoading, setIsFavoriteLoading] = useState<boolean>(true);
  
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  useEffect(() => {
    if (property?.created_at) {
      setDisplayDate(new Date(property.created_at).toLocaleDateString());
    }
  }, [property?.created_at]);

  useEffect(() => {
    if (!user || !property?.id) {
      setIsFavorited(false);
      setIsFavoriteLoading(false);
      return;
    }

    const checkFavoriteStatus = async () => {
      setIsFavoriteLoading(true);
      try {
        const { data, error } = await supabase
          .from('user_favorites')
          .select('property_id')
          .eq('user_id', user.id)
          .eq('property_id', property.id)
          .maybeSingle();

        if (error) throw error;
        setIsFavorited(!!data);
      } catch (err) {
        console.error("Error checking favorite status:", err);
      } finally {
        setIsFavoriteLoading(false);
      }
    };

    checkFavoriteStatus();
  }, [user, property?.id]);

  const handleToggleFavorite = async () => {
    if (!user) {
      router.push('/sign-in');
      return;
    }
    if (!property?.id) return;

    setIsFavoriteLoading(true);

    try {
      if (isFavorited) {
        const { error } = await supabase
          .from('user_favorites')
          .delete()
          .match({ user_id: user.id, property_id: property.id });

        if (error) throw error;
        setIsFavorited(false);
      } else {
        const { error } = await supabase
          .from('user_favorites')
          .insert({ user_id: user.id, property_id: property.id });

        if (error) throw error;
        setIsFavorited(true);
      }
    } catch (err: any) {
      console.error("Error toggling favorite:", err);
    } finally {
      setIsFavoriteLoading(false);
    }
  };

  const openImageViewer = (index: number) => {
    setSelectedImageIndex(index);
    setIsViewerOpen(true);
  };

  if (!property) {
    return (
      <div className="text-center p-8 text-lg text-danger-color">
        Property details are unavailable.
      </div>
    );
  }
  
  const DetailItem = ({ icon: Icon, label, value }: { icon: React.ElementType, label: string, value: string | number}) => (
    <div className="flex items-center gap-4 p-4 rounded-2xl shadow-neumorphic-inset-sm">
      <Icon className="h-6 w-6 text-text-color-light" />
      <div>
        <p className="text-sm text-text-color-light">{label}</p>
        <p className="font-semibold text-text-color-dark">{value}</p>
      </div>
    </div>
  );

  return (
    <>
      <div className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8">
        <div className="shadow-neumorphic-outset rounded-3xl p-6 md:p-8">
          <div className="flex flex-col md:flex-row justify-between items-start mb-4">
            <h1 className="text-3xl font-bold text-text-color-dark mb-2 md:mb-0">{property.title}</h1>
            <div className="flex items-center gap-2 self-start md:self-center flex-shrink-0">
              {ownerPhone && (
                  <WhatsAppButton
                      phoneNumber={ownerPhone}
                      propertyTitle={property.title}
                      propertyId={property.id}
                      ownerId={""} // Pass actual owner id if available
                      className="p-3 rounded-full"
                  >
                     <FaWhatsapp size={20} />
                  </WhatsAppButton>
              )}
              {user && (
                <button
                  onClick={handleToggleFavorite}
                  disabled={isFavoriteLoading || !property?.id}
                  className={`neumorphic-button p-3 rounded-full ${isFavorited ? 'bg-danger-color text-white' : ''}`}
                >
                  {isFavoriteLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Heart className={`h-5 w-5 ${isFavorited ? 'fill-current' : ''}`} />}
                </button>
              )}
            </div>
          </div>
          
          <div className="mb-6">
            <p className="mb-4 text-text-color-light">{property.description}</p>
            <p className="text-4xl font-bold text-success-color">
              ₹{property.price.toLocaleString()}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
             <DetailItem icon={MapPin} label="Location" value={property.location_text} />
             <DetailItem icon={Building} label="Property Type" value={property.property_type} />
             <DetailItem icon={Tag} label="Listing For" value={property.listing_type} />
             <DetailItem icon={FaBed} label="Configuration" value={property.bhk_type} />
             <DetailItem icon={FaRulerCombined} label="Area" value={`${property.area} sqft`} />
             <DetailItem icon={Calendar} label="Posted On" value={displayDate} />
          </div>

          <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Images</h2>
          {images && images.length > 0 ? (
            <div className="relative">
              <Carousel opts={{ loop: images.length > 1 }} className="w-full">
                <CarouselContent className="-ml-2">
                  {images.map((img, index) => (
                    <CarouselItem key={img.id} onClick={() => openImageViewer(index)} className="cursor-pointer pl-2">
                      <div className="p-1 shadow-neumorphic-inset-sm rounded-2xl">
                        <img
                          src={img.image_url!}
                          alt={`Image ${img.id} of ${property.title}`}
                          className="w-full h-64 object-cover rounded-xl"
                          onError={(e) => {
                            e.currentTarget.src = 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=Image+Error';
                            e.currentTarget.onerror = null;
                          }}
                        />
                      </div>
                    </CarouselItem>
                  ))}
                </CarouselContent>
                {images.length > 1 && ( <> <CarouselPrevious /> <CarouselNext /> </> )}
              </Carousel>
            </div>
          ) : (
            <p className="mt-4 italic text-text-color-light text-center">No images available.</p>
          )}
        </div>
      </div>

      {isViewerOpen && (
        <FullScreenImageViewer
          images={images}
          initialIndex={selectedImageIndex}
          onClose={() => setIsViewerOpen(false)}
        />
      )}
    </>
  );
}
