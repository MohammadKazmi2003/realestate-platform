// src/app/property/[id]/PropertyDetailsClient.tsx
'use client';

import { useState, useEffect } from 'react';
import type { PropertyDataType, MediaItem, LookupItem } from '@/lib/types';
import { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext } from '@/components/ui/carousel';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { WhatsAppButton } from '@/app/components/WhatsAppButton';
import { FullScreenImageViewer } from '@/app/components/FullScreenImageViewer';
import { LocationMap } from '@/app/components/LocationMap';
import { FaBed, FaBath, FaBuilding, FaTags, FaRulerCombined, FaRegClock, FaRegHandshake, FaRegFileAlt, FaChair, FaAward, FaTree } from 'react-icons/fa';
import { Heart, MapPin, Loader2, Briefcase, CheckCircle, Building2, User, DoorOpen } from 'lucide-react';
import { formatMoney, formatArea } from '@/lib/format';
import { tenant } from '@/lib/tenant';

type Props = {
  property: PropertyDataType;
};

// This component is unchanged and preserved
const DetailItem = ({ icon: Icon, label, value }: { icon: React.ElementType, label: string, value?: string | number | boolean | null }) => {
    if (value === null || value === undefined || value === '') return null;
    const displayValue = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);
    return (
        <div className="flex items-start gap-4 p-4 rounded-2xl shadow-neumorphic-inset">
            <Icon className="h-6 w-6 text-text-color-light flex-shrink-0 mt-1" />
            <div>
                <p className="text-sm text-text-color-light">{label}</p>
                <p className="font-semibold text-text-color-dark">{displayValue}</p>
            </div>
        </div>
    );
};

// This component is unchanged and preserved
const FeatureList = ({ title, items }: { title: string, items: LookupItem[] | undefined }) => {
    if (!items || items.length === 0) return null;
    return (
        <div className='mt-10'>
            <h3 className="text-xl font-semibold mb-4 text-text-color-dark border-b border-shadow-dark/20 pb-2">{title}</h3>
            <div className="flex flex-wrap gap-3">
                {items.map(item => (
                    <div key={item.name} className="bg-bg-color shadow-neumorphic-outset text-text-color-dark font-medium px-4 py-2 rounded-full text-sm flex items-center gap-2">
                        <CheckCircle size={16} className="text-success-color" />
                        {item.name}
                    </div>
                ))}
            </div>
        </div>
    );
};

export default function PropertyDetailClient({ property }: Props) {
  const { user } = useAuth();
  const router = useRouter();

  const [isFavorited, setIsFavorited] = useState<boolean>(false);
  const [isFavoriteLoading, setIsFavoriteLoading] = useState<boolean>(true);
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [displayDate, setDisplayDate] = useState<string>('');
  
  useEffect(() => {
    if (property?.created_at) {
      setDisplayDate(new Date(property.created_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric'
      }));
    }
  }, [property?.created_at]);

  const images: MediaItem[] = property.property_media?.filter(m => m.media_type === 'image') || [];
  
  useEffect(() => {
    if (!user || !property?.id) {
      setIsFavoriteLoading(false);
      return;
    }
    const checkFavoriteStatus = async () => {
        setIsFavoriteLoading(true);
        try {
            const { data } = await supabase.from('user_favorites').select('property_id').eq('user_id', user.id).eq('property_id', property.id).maybeSingle();
            setIsFavorited(!!data);
        } catch (err) { console.error("Error checking favorite status:", err); } 
        finally { setIsFavoriteLoading(false); }
    };
    checkFavoriteStatus();
  }, [user, property?.id]);

  const handleToggleFavorite = async () => {
      if (!user) { router.push('/sign-in'); return; }
      if (!property?.id) return;
  
      setIsFavoriteLoading(true);
      try {
        if (isFavorited) {
          const { error } = await supabase.from('user_favorites').delete().match({ user_id: user.id, property_id: property.id });
          if (error) throw error;
          setIsFavorited(false);
        } else {
          const { error } = await supabase.from('user_favorites').insert({ user_id: user.id, property_id: property.id });
          if (error) throw error;
          setIsFavorited(true);
        }
      } catch (err: any) { console.error("Error toggling favorite:", err); } 
      finally { setIsFavoriteLoading(false); }
  };

  const openImageViewer = (index: number) => {
    setSelectedImageIndex(index);
    setIsViewerOpen(true);
  };
  
  const residentialDetails = property.details_residential?.[0];
  const commercialDetails = property.details_commercial?.[0];
  const landDetails = property.details_land?.[0];

  return (
    <>
      <div className="max-w-5xl mx-auto p-4 sm:p-6 lg:p-8">
        <div className="shadow-neumorphic-outset rounded-3xl p-6 md:p-8 space-y-12">
            <section>
                <div className="flex flex-col md:flex-row justify-between items-start mb-4">
                    <h1 className="text-3xl font-bold text-text-color-dark mb-2 md:mb-0">{property.title}</h1>
                    <div className="flex items-center gap-2 self-start md:self-center flex-shrink-0">
                        <WhatsAppButton phoneNumber={property.profiles?.phone_number || null} propertyTitle={property.title || 'this property'} propertyId={property.id} ownerId={property.user_id} />
                        {user && (
                            <button onClick={handleToggleFavorite} disabled={isFavoriteLoading} className={`neumorphic-button p-3 rounded-full ${isFavorited ? 'shadow-neumorphic-inset bg-danger-color/80 text-white' : ''}`}>
                                {isFavoriteLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Heart className={`h-5 w-5 ${isFavorited ? 'fill-current' : ''}`} />}
                            </button>
                        )}
                    </div>
                </div>
                <p className="flex items-center gap-2 text-text-color-light"><MapPin size={16} /> {property.location_text}</p>
            </section>

            <section>
                <p className="text-4xl font-bold text-success-color mb-2">
                    {property.price ? formatMoney(property.price, tenant.propertyCurrency) : 'Price on request'}
                    {property.is_price_negotiable && <span className="text-sm font-normal text-text-color-light ml-2">(Negotiable)</span>}
                </p>
                <p className="text-text-color-light">{property.description}</p>
            </section>
            
            <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Overview</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {residentialDetails && (
                        <>
                            <DetailItem icon={FaBed} label="Configuration" value={residentialDetails.bhk_types?.label} />
                            <DetailItem icon={FaRulerCombined} label="Carpet Area" value={formatArea(residentialDetails.carpet_area, null)} />
                            <DetailItem icon={FaBath} label="Bathrooms" value={residentialDetails.bathrooms} />
                            <DetailItem icon={DoorOpen} label="Balconies" value={residentialDetails.balconies} />
                            <DetailItem icon={FaTags} label="Furnishing" value={residentialDetails.lookup_furnishing_statuses?.name} />
                            <DetailItem icon={Building2} label="Floor" value={residentialDetails.total_floors ? `Floor ${residentialDetails.property_on_floor} of ${residentialDetails.total_floors}` : null} />
                        </>
                    )}
                    {commercialDetails && (
                         <>
                         <DetailItem icon={Briefcase} label="Commercial Type" value={commercialDetails.lookup_commercial_sub_types?.name} />
                         <DetailItem icon={FaBuilding} label="Office Type" value={commercialDetails.office_type?.name} />
                          <DetailItem icon={FaRulerCombined} label="Carpet Area" value={formatArea(commercialDetails.carpet_area, null)} />
                         <DetailItem icon={Building2} label="Floor" value={commercialDetails.total_floors ? `Floor ${commercialDetails.property_on_floor} of ${commercialDetails.total_floors}` : null} />
                         <DetailItem icon={FaChair} label="Minimum Seats" value={commercialDetails.min_seats} />
                         <DetailItem icon={FaChair} label="Maximum Seats" value={commercialDetails.max_seats} />
                         <DetailItem icon={FaChair} label="Cabins" value={commercialDetails.cabins} />
                         <DetailItem icon={FaBath} label="Private Washrooms" value={commercialDetails.private_washrooms} />
                         <DetailItem icon={FaBath} label="Shared Washrooms" value={commercialDetails.shared_washrooms} />
                         <DetailItem icon={FaBuilding} label="Passenger Lifts" value={commercialDetails.passenger_lifts} />
                         <DetailItem icon={FaBuilding} label="Service Lifts" value={commercialDetails.service_lifts} />
                         <DetailItem icon={CheckCircle} label="Pre-Leased" value={commercialDetails.is_pre_leased} />
                         <DetailItem icon={FaAward} label="NOC Certified" value={commercialDetails.has_noc} />
                         <DetailItem icon={FaAward} label="Occupancy Certificate" value={commercialDetails.has_occupancy_cert} />
                       </>
                    )}
                    {landDetails && (
                         <>
                              <DetailItem icon={FaRulerCombined} label="Plot Area" value={landDetails.plot_area ? formatArea(landDetails.plot_area, landDetails.area_unit) : null} />
                             <DetailItem icon={FaTree} label="Boundary Wall" value={landDetails.is_boundary_wall_made ? 'Yes' : 'No'} />
                         </>
                     )}
                    <DetailItem icon={FaBuilding} label="Property Type" value={property.property_types?.name} />
                    <DetailItem icon={FaTags} label="For" value={property.lookup_listing_purposes?.name} />
                    <DetailItem icon={FaRegClock} label="Availability" value={property.lookup_availability_statuses?.name} />
                    <DetailItem icon={FaRegHandshake} label="Ownership" value={property.lookup_ownership_types?.name} />
                    <DetailItem icon={FaRegFileAlt} label="Posted On" value={displayDate} />
                    <DetailItem icon={User} label="Posted By" value={property.profiles?.name} />
                </div>
            </section>
            
            <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Gallery</h2>
                {images.length > 0 ? (
                    <Carousel opts={{ loop: images.length > 1 }} className="w-full">
                        <CarouselContent className="-ml-2">
                        {images.map((img, index) => (
                            <CarouselItem key={img.id} onClick={() => openImageViewer(index)} className="cursor-pointer pl-2 basis-full md:basis-1/2 lg:basis-1/3">
                            <div className="p-1 shadow-neumorphic-inset-sm rounded-2xl group">
                                <div className="relative overflow-hidden rounded-xl">
                                    <img src={img.media_url} alt={`${img.tag || 'Property Image'} - ${index + 1}`} loading="lazy" className="w-full h-64 object-cover group-hover:scale-105 transition-transform duration-300"/>
                                    {img.tag && <div className="absolute bottom-0 left-0 bg-black/50 text-white px-3 py-1 text-sm font-semibold rounded-tr-xl">{img.tag}</div>}
                                </div>
                            </div>
                            </CarouselItem>
                        ))}
                        </CarouselContent>
                        {images.length > 1 && (<><CarouselPrevious /><CarouselNext /></>)}
                    </Carousel>
                ) : (
                    <div className="text-center py-10 shadow-neumorphic-inset rounded-2xl">
                        <p className="italic text-text-color-light">No images available for this property.</p>
                    </div>
                )}
            </section>

            {/* ADDED: Location Map Section */}
            <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Location</h2>
                <LocationMap latitude={property.latitude} longitude={property.longitude} />
            </section>

            <section>
                <FeatureList title="Amenities" items={property.lookup_amenities} />
                <FeatureList title="Furnishing Details" items={property.lookup_furnishing_items} />
                <FeatureList title="Other Rooms" items={property.lookup_other_rooms} />
                <FeatureList title="Location Advantages" items={property.lookup_location_advantages} />
                {/* *** FIX: Added the new FeatureList for Land Features *** */}
                <FeatureList title="Land & Plot Features" items={property.lookup_land_features} />
            </section>
        </div>
      </div>
      {isViewerOpen && (
        <FullScreenImageViewer images={images} initialIndex={selectedImageIndex} onClose={() => setIsViewerOpen(false)} />
      )}
    </>
  );   
}
