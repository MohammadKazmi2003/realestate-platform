// src/app/components/Header.tsx
'use client'

import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { LogOut, LogIn, Home, Heart, List, PlusSquare, Building2, User, Shield, Briefcase, Calendar as CalendarIcon, MessageCircle } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { ChatAssistant } from './ChatAssistant'

export default function Header() {
  const router = useRouter()
  const { user, session } = useAuth()
  const [userRole, setUserRole] = useState<number | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);

  useEffect(() => {
    const getProfile = async () => {
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role_id')
          .eq('id', user.id)
          .single();
        if (profile) {
          setUserRole(profile.role_id);
        }
      } else {
        setUserRole(null);
      }
    };
    getProfile();
  }, [user]);

  const handleLogout = async () => {
    await supabase.auth.signOut()
    setUserRole(null);
    router.push('/sign-in')
    router.refresh(); 
  }

  const NavLink = ({ href, icon: Icon, children }: { href: string, icon: React.ElementType, children: React.ReactNode }) => (
    <Link href={href} className="flex items-center gap-2 text-text-color-light hover:text-text-color-dark transition-colors duration-150 ease-in-out p-2 rounded-2xl hover:shadow-neumorphic-outset active:shadow-neumorphic-inset">
      <Icon size={18} />
      <span className="text-sm font-medium">{children}</span>
    </Link>
  );

  return (
    <header className="w-full px-4 sm:px-6 py-3 flex items-center justify-between z-10 sticky top-0 bg-bg-color">
      
      <div className="flex-1 flex justify-start">
        <Link href="/" className="text-xl font-bold text-text-color-dark hover:text-opacity-80 transition-colors flex items-center gap-2">
          <Home size={24}/>
          <span className="hidden sm:inline">Soft Homes</span>
        </Link>
      </div>
      
      <div className="flex-1 hidden md:flex justify-center">
        <nav className="flex items-center gap-2 bg-bg-color p-2 rounded-full shadow-neumorphic-outset">
          <NavLink href="/browse" icon={Building2}>Browse</NavLink>
          <NavLink href="/list" icon={List}>List</NavLink>
          {userRole === 1 && <NavLink href="/admin" icon={Shield}>Admin</NavLink>}
          {userRole === 2 && <NavLink href="/propertyowner" icon={User}>Dashboard</NavLink>}
          {userRole === 3 && (
            <>
              <NavLink href="/propertyowner" icon={User}>Dashboard</NavLink>
              <NavLink href="/agent/leads" icon={Briefcase}>Leads</NavLink>
              <NavLink href="/agent/calendar" icon={CalendarIcon}>Calendar</NavLink>
            </>
          )}
          {user && <NavLink href="/my-listings" icon={List}>My Listings</NavLink>}
          {user && <NavLink href="/favorites" icon={Heart}>Favorites</NavLink>}
        </nav>
      </div>

      <div className="flex-1 flex justify-end">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsChatOpen(true)}
            className="neumorphic-button flex items-center justify-center p-3 rounded-full"
            title="AI Property Assistant"
          >
            <MessageCircle size={16} />
          </button>
          {session ? (
              <>
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

      <ChatAssistant isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
    </header>
  )
}
