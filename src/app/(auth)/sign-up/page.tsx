'use client'

import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { supabase } from '@/lib/supabaseClient'

export default function SignUp() {
  return (
    <div className="flex justify-center items-center min-h-screen bg-gray-100">
      <Auth
        supabaseClient={supabase}
        view="sign_up"
        appearance={{ theme: ThemeSupa }}
        theme="light"
        providers={['google']}
        redirectTo="/"
      />
    </div>
  )
}
