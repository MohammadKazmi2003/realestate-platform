'use client'

import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { supabase } from '@/lib/supabaseClient'
import Link from 'next/link'

export default function SignUp() {
  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100">
      <div className="w-full max-w-md mx-4">
        <Auth
          supabaseClient={supabase}
          view="sign_up"
          appearance={{ theme: ThemeSupa }}
          theme="light"
          providers={['google', 'apple']}
          redirectTo="/"
        />
        <div className="mt-4 text-center">
          <Link href="/phone-sign-up" className="text-sm text-blue-600 hover:underline font-medium">
            Sign up with phone number
          </Link>
        </div>
      </div>
    </div>
  )
}
