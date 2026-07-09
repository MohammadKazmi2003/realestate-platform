// src/context/AuthContext.tsx
'use client'

import { useEffect, useState, createContext, useContext } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import type { Session, User } from '@supabase/supabase-js'

const AuthContext = createContext<{
  user: User | null
  session: Session | null
  loading: boolean
  userId: string | null
  userRoleId: number | null
  userRole: string | null
}>({
  user: null,
  session: null,
  loading: true,
  userId: null,
  userRoleId: null,
  userRole: null,
})

/** Reads role_id from user.app_metadata (populated by DB trigger). */
function getRoleId(user: User | null): number | null {
  const raw = user?.app_metadata?.user_role_id
  return typeof raw === 'number' && raw > 0 ? raw : null
}

/** Reads role name from user.app_metadata. */
function getRoleName(user: User | null): string | null {
  const raw = user?.app_metadata?.user_role
  return typeof raw === 'string' ? raw : null
}

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter()
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  const userId = user?.id ?? null
  const userRoleId = getRoleId(user)
  const userRole = getRoleName(user)

  useEffect(() => {
    const getInitialSession = async () => {
      const { data } = await supabase.auth.getSession()
      setSession(data.session)
      setUser(data.session?.user ?? null)
      setLoading(false)

      // Redirect default-role users to onboarding
      if (data.session?.user && getRoleId(data.session.user) === 4) {
        router.replace('/onboarding')
      }
    }

    getInitialSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession)
      setUser(newSession?.user ?? null)
      setLoading(false)

      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && newSession?.user) {
        if (getRoleId(newSession.user) === 4) {
          router.replace('/onboarding')
        }
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [router])

  return (
    <AuthContext.Provider value={{ user, session, loading, userId, userRoleId, userRole }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
