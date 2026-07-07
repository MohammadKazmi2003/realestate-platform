// src/middleware.ts
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(req: NextRequest) {
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

  const protectedPaths = ['/admin', '/propertyowner', '/agent', '/my-listings', '/favorites', '/add-property', '/edit-property']
  if (!user && protectedPaths.some(path => req.nextUrl.pathname.startsWith(path))) {
    return NextResponse.redirect(new URL('/sign-in', req.url))
  }

  if (user) {
    // Role is embedded in the JWT via custom_access_token_hook — no DB query needed.
    const role = user.app_metadata?.user_role_id as number | undefined

    if (req.nextUrl.pathname.startsWith('/admin') && role !== 1) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    if (req.nextUrl.pathname.startsWith('/propertyowner') && !(role === 2 || role === 3)) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    if (req.nextUrl.pathname.startsWith('/agent') && role !== 3) {
      return NextResponse.redirect(new URL('/', req.url))
    }
  }

  return res
}

export const config = {
  matcher: ['/sign-in', '/sign-up', '/admin/:path*', '/propertyowner/:path*', '/agent/:path*', '/my-listings/:path*', '/favorites/:path*', '/add-property/:path*', '/edit-property/:path*'],
}
