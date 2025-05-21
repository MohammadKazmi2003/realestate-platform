'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import Header from '@/app/components/Header'
import Link from 'next/link'

type Property = {
  id: string
  title: string
  description: string
  price: number
  bhk_type: string
  area: number
}

type PropertyImage = {
  id: string
  image_url: string
}

export default function PropertyList() {
  const [properties, setProperties] = useState<Property[]>([])
  const [images, setImages] = useState<{ [key: string]: PropertyImage[] }>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchProperties = async () => {
      const { data: propertiesData, error: propertiesError } = await supabase
        .from('properties')
        .select('id, title, description, price, bhk_type, area')
        .limit(10)

      if (propertiesError) {
        console.error('Error fetching properties:', propertiesError.message)
      } else {
        setProperties(propertiesData || [])
      }
      setLoading(false)
    }

    fetchProperties()
  }, [])

  useEffect(() => {
    const fetchImages = async () => {
      const imagePromises = properties.map(async (property) => {
        const { data: imagesData, error: imagesError } = await supabase
          .from('property_images')
          .select('image_url')
          .eq('property_id', property.id)

        if (imagesError) {
          console.error('Error fetching images for property:', imagesError.message)
          return { [property.id]: [] }
        }

        return { [property.id]: imagesData || [] }
      })

      const imagesResult = await Promise.all(imagePromises)
      const imagesMap = imagesResult.reduce((acc, item) => ({ ...acc, ...item }), {})
      setImages(imagesMap)
    }

    if (properties.length > 0) {
      fetchImages()
    }
  }, [properties])

  if (loading) return <p>Loading properties...</p>

  return (
    <>
      <Header />
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 p-4">
        {properties.map((property) => (
          <Link
            href={`/view-property/${property.id}`}
            key={property.id}
            className="border rounded-md p-4 shadow hover:shadow-lg transition block"
          >
            <h2 className="text-xl font-semibold mb-1">{property.title}</h2>
            <p className="text-sm text-gray-600">{property.bhk_type} • {property.area} sqft</p>
            <p className="text-md text-green-700 font-bold mt-2">₹{property.price.toLocaleString()}</p>
            <p className="text-sm text-gray-800 mt-1">{property.description}</p>

            <div className="mt-4">
              <h3 className="text-lg font-semibold">Images:</h3>
              <div className="grid grid-cols-3 gap-2">
                {images[property.id]?.map((image: PropertyImage) => (
                  <img key={image.image_url} src={image.image_url} alt="Property" className="w-full h-auto rounded-md" />
                ))}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  )
}
