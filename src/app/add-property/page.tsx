'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import Header from '@/app/components/Header'
import { withAuth } from '@/utils/withAuth' // ✅ Import

function AddPropertyPage() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [bhkType, setBhkType] = useState('')
  const [area, setArea] = useState('')
  const [images, setImages] = useState<FileList | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    const user = (await supabase.auth.getUser()).data.user
    if (!user) {
      alert('Please sign in')
      setLoading(false)
      return
    }

    const { data: property, error: propertyError } = await supabase
      .from('properties')
      .insert({
        title,
        description,
        price: parseFloat(price),
        bhk_type: bhkType,
        area: parseFloat(area),
        user_id: user.id,
      })
      .select()
      .single()

    if (propertyError || !property) {
      console.error('Error inserting property:', propertyError)
      setLoading(false)
      return
    }

    const uploadedImageUrls: string[] = []

    if (images) {
      for (let i = 0; i < images.length; i++) {
        const file = images[i]
        const fileExt = file.name.split('.').pop()
        const fileName = `${Date.now()}-${Math.random()}.${fileExt}`
        const filePath = `properties/${property.id}/${fileName}`

        const { error: uploadError } = await supabase.storage
          .from('property-images')
          .upload(filePath, file)

        if (uploadError) {
          console.error('Error uploading image:', uploadError)
          continue
        }

        const {
          data: { publicUrl },
        } = supabase.storage.from('property-images').getPublicUrl(filePath)

        uploadedImageUrls.push(publicUrl)
      }

      const { error: imageInsertError } = await supabase
        .from('property_images')
        .insert(
          uploadedImageUrls.map((url) => ({
            property_id: property.id,
            image_url: url,
          }))
        )

      if (imageInsertError) {
        console.error('Error inserting image URLs:', imageInsertError)
      }
    }

    setLoading(false)
    router.push(`/view-property/${property.id}`)
  }

  return (
    <>
      <Header />
      <div className="max-w-xl mx-auto mt-8 p-4 bg-white shadow rounded">
        <h1 className="text-2xl font-bold mb-4">Add New Property</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="w-full border p-2 rounded"
          />
          <textarea
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            className="w-full border p-2 rounded"
          />
          <input
            type="number"
            placeholder="Price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
            className="w-full border p-2 rounded"
          />
          <input
            type="text"
            placeholder="BHK Type (e.g., 2BHK)"
            value={bhkType}
            onChange={(e) => setBhkType(e.target.value)}
            required
            className="w-full border p-2 rounded"
          />
          <input
            type="number"
            placeholder="Area (in sqft)"
            value={area}
            onChange={(e) => setArea(e.target.value)}
            required
            className="w-full border p-2 rounded"
          />
          <input
            type="file"
            multiple
            accept="image/*"
            onChange={(e) => setImages(e.target.files)}
            className="w-full"
          />
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            {loading ? 'Submitting...' : 'Submit Property'}
          </button>
        </form>
      </div>
    </>
  )
}

// ✅ Wrap with withAuth and export ONLY ONCE
export default withAuth(AddPropertyPage)
