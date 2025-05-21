'use client'

import { useState } from 'react'
import imageCompression from 'browser-image-compression'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function ImageUpload({ propertyId }: { propertyId: string }) {
  const [uploading, setUploading] = useState(false)

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)

    try {
      // Compress the image
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.5,
        maxWidthOrHeight: 1024,
        useWebWorker: true
      })

      // Set the path for the image in Supabase storage
      const filePath = `${propertyId}/${Date.now()}_${file.name}`

      // Upload the compressed image to Supabase Storage
      const { data, error: uploadError } = await supabase.storage
        .from('property-images')
        .upload(filePath, compressed, {
          cacheControl: '3600',
          upsert: true
        })

      if (uploadError) throw uploadError

      // Get the public URL of the uploaded image
      const imageUrl = `${supabase.storage.from('property-images').getPublicUrl(filePath).publicURL}`

      // Insert the image metadata into the database
      const { error: dbError } = await supabase
        .from('property_images')
        .insert([
          {
            property_id: propertyId,
            image_url: imageUrl,
          }
        ])

      if (dbError) throw dbError

      alert('Image uploaded and metadata saved successfully')
    } catch (error) {
      console.error('Error uploading image:', error)
      alert('Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div>
      <input
        type="file"
        accept="image/*"
        onChange={handleUpload}
        disabled={uploading}
      />
      {uploading && <p>Uploading...</p>}
    </div>
  )
}
