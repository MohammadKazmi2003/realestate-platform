'use client'

export const dynamic = 'force-dynamic';

import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { supabase } from '@/lib/supabaseClient'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function SignInPage() {
  const router = useRouter()

  useEffect(() => {
    // Watch for auth state changes and redirect manually
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, _session) => {
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
    <div className="flex items-center justify-center min-h-screen bg-bg-color">
      <div className="w-full max-w-md mx-4">
        <Auth
          supabaseClient={supabase}
          appearance={{ theme: ThemeSupa }}
          theme="dark"
          providers={[]} // Add providers if needed
          redirectTo={typeof window !== 'undefined' ? `${window.location.origin}/` : '/'}
        />
        <div className="text-center mt-4 space-x-4 text-sm">
          <Link href="/forgot-password" className="text-text-color-light hover:text-text-color-dark hover:underline">Forgot password?</Link>
          <span className="text-text-color-light">·</span>
          <Link href="/sign-up" className="text-text-color-light hover:text-text-color-dark hover:underline">Create account</Link>
        </div>
      </div>
    </div>
  )
}
