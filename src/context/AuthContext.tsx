// src/context/AuthContext.tsx
'use client'

import { useEffect, useState, createContext, useContext } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import type { Session, User } from '@supabase/supabase-js'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const AuthContext = createContext<{
  user: User | null
  session: Session | null
  loading: boolean // Add loading state to context
}>({
  user: null,
  session: null,
  loading: true, // Initialize loading as true
})

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState<boolean>(true) // Internal loading state

  useEffect(() => {
    const getInitialSession = async () => { // Renamed for clarity
      const { data } = await supabase.auth.getSession()
      setSession(data.session)
      setUser(data.session?.user ?? null)
      setLoading(false) // Set loading to false once initial session is retrieved
    }

    getInitialSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      setUser(newSession?.user ?? null)
      setLoading(false) // Also set loading to false on any auth state change
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  return (
    <AuthContext.Provider value={{ user, session, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
