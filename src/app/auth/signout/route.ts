import { createSupabaseServerClient } from '@/lib/supabase/serverClient'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()
  // Use request origin so redirect works in Chrome and VS Code browser
  const origin = req.nextUrl.origin
  return NextResponse.redirect(new URL('/sign-in', origin))
}
