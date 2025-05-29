'use client'

import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useEffect, useState } from 'react'
import Link from 'next/link'

export default function Header() {
  const router = useRouter()
  const [userEmail, setUserEmail] = useState('')

  useEffect(() => {
    const getUser = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.user) {
        router.push('/sign-in')
      } else {
        setUserEmail(session.user.email)
      }
    }

    getUser()
  }, [router])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/sign-in')
  }

  return (
    <header className="w-full bg-gray-800 text-white px-6 py-4 flex justify-between items-center">
      <h1 className="text-xl font-bold">🏠 RealEstate Platform</h1>
      
      <nav className="flex items-center gap-6">
        <Link href="/" className="hover:underline">
          Home
        </Link>
        <Link href="/add-property" className="hover:underline">
          Add Property
        </Link>
        <Link href="/favorites" className="hover:underline">
           Favorites
        </Link>
        <Link href="/my-listings" className="hover:underline"> 
            My Listings
        </Link>
        <Link href="/map" className="hover:underline">
          Map View
        </Link>
        <Link href="/browse" className="hover:underline">
          Browse
        </Link>
      </nav>

      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-300">{userEmail}</span>
        <button
          onClick={handleLogout}
          className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded"
        >
          Logout
        </button>
      </div>
    </header>
  )
}
