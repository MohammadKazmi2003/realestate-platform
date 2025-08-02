// src/middleware.ts
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(req: NextRequest) {
  // --- FIX: Explicitly bypass API routes ---
  // This check runs first. If the request is for an API route,
  // it immediately passes it through without running any auth logic.
  if (req.nextUrl.pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  const res = NextResponse.next()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return req.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          req.cookies.set({
            name,
            value,
            ...options,
          })
        },
        remove(name: string, options: CookieOptions) {
          req.cookies.set({
            name,
            value: '',
            ...options,
          })
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user && (req.nextUrl.pathname === '/sign-in' || req.nextUrl.pathname === '/sign-up')) {
    return NextResponse.redirect(new URL('/', req.url))
  }

  const protectedPaths = ['/admin', '/propertyowner', '/agent'];
  if (!user && protectedPaths.some(path => req.nextUrl.pathname.startsWith(path))) {
    return NextResponse.redirect(new URL('/sign-in', req.url))
  }

  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role_id')
      .eq('id', user.id)
      .single()

    const role = profile?.role_id;

    if (req.nextUrl.pathname.startsWith('/admin') && role !== 1) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    if (req.nextUrl.pathname.startsWith('/propertyowner') && ![2, 3].includes(role as number)) {
      return NextResponse.redirect(new URL('/', req.url))
    }
    
    if (req.nextUrl.pathname.startsWith('/agent') && role !== 3) {
      return NextResponse.redirect(new URL('/', req.url))
    }
  }

  return res
}

// We can now simplify the matcher, as the function logic handles the API bypass.
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
