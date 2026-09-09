'use client'

export const dynamic = 'force-dynamic';

import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { supabase } from '@/lib/supabaseClient'
import Link from 'next/link'

export default function SignUp() {
  return (
    <div className="flex justify-center items-center min-h-screen bg-bg-color">
      <div className="w-full max-w-md mx-4">
        <Auth
          supabaseClient={supabase}
          view="sign_up"
          appearance={{ theme: ThemeSupa }}
          theme="light"
          providers={[]}
          redirectTo={typeof window !== 'undefined' ? `${window.location.origin}/` : '/'}
        />
        <div className="text-center mt-4 text-sm">
          <Link href="/sign-in" className="text-text-color-light hover:text-text-color-dark hover:underline">Already have an account? Sign in</Link>
        </div>
        <p className="text-center mt-2 text-xs text-text-color-light">Local dev emails: http://127.0.0.1:54324 (Inbucket)</p>
      </div>
    </div>
  )
}
