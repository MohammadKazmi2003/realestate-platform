'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useRouter } from 'next/navigation'


export default function AddPropertyForm() {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    price: '',
    bhk_type: '',
    area: ''
  })

  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    const { data, error } = await supabase.from('properties').insert([
      {
        title: formData.title,
        description: formData.description,
        price: Number(formData.price),
        bhk_type: formData.bhk_type,
        area: Number(formData.area)
      }
    ])

    setLoading(false)

    if (error) {
      alert('Error adding property')
      console.error(error)
    } else {
      alert('Property added successfully!')
      router.push('/')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl mx-auto p-4 space-y-4">
      <input type="text" name="title" placeholder="Title" onChange={handleChange} className="w-full p-2 border rounded" required />
      <textarea name="description" placeholder="Description" onChange={handleChange} className="w-full p-2 border rounded" required />
      <input type="number" name="price" placeholder="Price" onChange={handleChange} className="w-full p-2 border rounded" required />
      <input type="text" name="bhk_type" placeholder="BHK Type (e.g., 2 BHK)" onChange={handleChange} className="w-full p-2 border rounded" required />
      <input type="number" name="area" placeholder="Area (sqft)" onChange={handleChange} className="w-full p-2 border rounded" required />
      <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded" disabled={loading}>
        {loading ? 'Adding...' : 'Add Property'}
      </button>
    </form>
  )
}
