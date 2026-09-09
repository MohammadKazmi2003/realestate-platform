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
  signOut: () => Promise<void>
  // Compatibility with updated auth design (new-admin-features embeds
  // role in JWT via custom_access_token_hook). Basic version keeps the
  // profiles-table lookup but also exposes JWT claims when present.
  userRoleId: number | null
  userRole: string | null
}>({
  user: null,
  session: null,
  loading: true, // Initialize loading as true
  signOut: async () => {},
  userRoleId: null,
  userRole: null,
})

function getRoleIdFromUser(u: User | null): number | null {
  const raw = (u?.app_metadata as any)?.user_role_id;
  return typeof raw === 'number' && raw > 0 ? raw : null;
}

function getRoleNameFromUser(u: User | null): string | null {
  const raw = (u?.app_metadata as any)?.user_role;
  return typeof raw === 'string' ? raw : null;
}

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState<boolean>(true) // Internal loading state

  const signOut = async () => {
    try {
      // Server route clears httpOnly cookies (fixes inconsistent sign-out
      // between Chrome and VS Code browser where client-only signOut
      // leaves middleware session intact).
      await fetch('/auth/signout', { method: 'GET' });
    } catch {}
    await supabase.auth.signOut()
    setSession(null)
    setUser(null)
    // Force reload to clear any cached auth state in both browsers
    if (typeof window !== 'undefined') window.location.href = '/sign-in'
  }

  const userRoleId = getRoleIdFromUser(user)
  const userRole = getRoleNameFromUser(user)

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
    <AuthContext.Provider value={{ user, session, loading, signOut, userRoleId, userRole }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
