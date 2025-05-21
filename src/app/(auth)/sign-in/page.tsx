'use client'

import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { supabase } from '@/lib/supabaseClient'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function SignInPage() {
  const router = useRouter()

  useEffect(() => {
    // Watch for auth state changes and redirect manually
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN') {
        router.push('/')
      }
    })

    // Optional: redirect if already signed in
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.push('/')
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [router])

  return (
    <div className="flex items-center justify-center min-h-screen">
      <Auth
        supabaseClient={supabase}
        appearance={{ theme: ThemeSupa }}
        theme="dark"
        providers={[]} // Add providers if needed
      />
    </div>
  )
}
