// src/app/auth/signout/route.ts
// Route handler for sign-out. Uses the server client so Set-Cookie headers
// are properly included in the redirect response, clearing the session cookies.
import { createSupabaseServerClient } from '@/lib/supabase/serverClient'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.signOut()

  if (error) {
    console.error('Sign-out error:', error.message)
  }

  return NextResponse.redirect(new URL('/sign-in', 'http://localhost:3000'))
}
