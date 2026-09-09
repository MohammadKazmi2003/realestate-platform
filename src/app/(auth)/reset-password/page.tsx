'use client'

export const dynamic = 'force-dynamic';

import { useState, FormEvent, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // Supabase sends ?code=... ; exchange it for a session (works in Chrome + VS Code browser)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true)
      else {
        // Try code exchange explicitly for PKCE links
        const params = new URLSearchParams(window.location.search)
        const code = params.get('code')
        if (code) {
          supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
            if (!error) setReady(true)
          })
        } else {
          // Allow form anyway – updateUser will fail clearly if no session
          setReady(true)
        }
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setLoading(false)
    } else {
      router.push('/sign-in')
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg-color">
      <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color">
        <h1 className="text-2xl font-bold text-text-color-dark mb-2">Set new password</h1>
        <p className="text-text-color-light text-sm mb-6">Enter a new password (min 6 characters).</p>
        {error && <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="password" placeholder="New password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} className="neumorphic-input w-full" />
          <button type="submit" disabled={loading || !ready} className="neumorphic-button bg-cta-gradient w-full">{loading ? 'Updating...' : 'Update password'}</button>
        </form>
        <div className="mt-4 text-center"><Link href="/sign-in" className="text-sm text-text-color-light hover:text-text-color-dark">Back to sign in</Link></div>
      </div>
    </div>
  )
}
