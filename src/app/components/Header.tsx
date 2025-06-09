// src/app/components/Header.tsx
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

      if (session?.user?.email) {
        setUserEmail(session.user.email)
      }
    }
    getUser()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/sign-in')
  }

  return (
    <header className="w-full bg-gray-800 text-white px-6 py-4 flex justify-between items-center shadow-md z-50">
      <Link href="/" className="text-xl font-bold">
        🏠 RealEstate Platform
      </Link>
      
      <nav className="hidden md:flex items-center gap-6">
        <Link href="/" className="hover:underline">Home</Link>
        <Link href="/browse" className="hover:underline">Browse</Link>
        <Link href="/list" className="hover:underline">List</Link>
        <Link href="/add-property" className="hover:underline">Add Property</Link>
        <Link href="/favorites" className="hover:underline">Favorites</Link>
        <Link href="/my-listings" className="hover:underline">My Listings</Link>
      </nav>

      <div className="flex items-center gap-4">
        {userEmail ? (
            <>
                <span className="text-sm text-gray-300 hidden md:block">{userEmail}</span>
                <button
                    onClick={handleLogout}
                    className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm"
                >
                    Logout
                </button>
            </>
        ) : (
            <Link href="/sign-in" className="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-sm">
                Sign In
            </Link>
        )}
      </div>
    </header>
  )
}
