'use client'

import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { LogOut, LogIn, Home, Heart, List, PlusSquare, Building2 } from 'lucide-react'

export default function Header() {
  const router = useRouter()
  const [userEmail, setUserEmail] = useState('')

  useEffect(() => {
    const getUser = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user?.email) {
        setUserEmail(session.user.email)
      }
    }
    getUser()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user?.email ?? '');
    });

    return () => subscription.unsubscribe();
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    setUserEmail('');
    router.push('/sign-in')
  }

  // --- MODIFICATION --- Added `active:shadow-neumorphic-inset` for the click effect
  const NavLink = ({ href, icon: Icon, children }: { href: string, icon: React.ElementType, children: React.ReactNode }) => (
    <Link href={href} className="flex items-center gap-2 text-text-color-light hover:text-text-color-dark transition-colors duration-150 ease-in-out p-2 rounded-2xl hover:shadow-neumorphic-outset active:shadow-neumorphic-inset">
      <Icon size={18} />
      <span className="text-sm font-medium">{children}</span>
    </Link>
  );

  return (
    // This structure now uses a 3-column flex layout to ensure proper alignment
    <header className="w-full px-4 sm:px-6 py-3 flex items-center justify-between z-10 sticky top-0 bg-bg-color">
      
      {/* --- Left Section (Logo) --- */}
      <div className="flex-1 flex justify-start">
        <Link href="/" className="text-xl font-bold text-text-color-dark hover:text-opacity-80 transition-colors flex items-center gap-2">
          <Home size={24}/>
          <span className="hidden sm:inline">Soft Homes</span>
        </Link>
      </div>
      
      {/* --- Center Section (Navigation) --- */}
      <div className="flex-1 hidden md:flex justify-center">
        <nav className="flex items-center gap-2 bg-bg-color p-2 rounded-full shadow-neumorphic-outset">
          <NavLink href="/browse" icon={Building2}>Browse</NavLink>
          <NavLink href="/list" icon={List}>List</NavLink>
          <NavLink href="/my-listings" icon={List}>My Listings</NavLink>
          <NavLink href="/favorites" icon={Heart}>Favorites</NavLink>
        </nav>
      </div>

      {/* --- Right Section (Actions & Auth) --- */}
      <div className="flex-1 flex justify-end">
        <div className="flex items-center gap-2">
          {userEmail ? (
              <>
                  {/* Username is now removed from display */}
                  <button
                      onClick={handleLogout}
                      className="neumorphic-button flex items-center justify-center p-3 rounded-full"
                      title="Logout"
                  >
                      <LogOut size={16} />
                  </button>
              </>
          ) : (
              <Link href="/sign-in" className="neumorphic-button flex items-center justify-center p-3 rounded-full" title="Sign In">
                  <LogIn size={16}/>
              </Link>
          )}
          <Link href="/add-property" className="neumorphic-button bg-cta-gradient flex items-center gap-2">
              <PlusSquare size={16}/>
              <span className="hidden sm:inline">Add Property</span>
          </Link>
        </div>
      </div>
    </header>
  )
}