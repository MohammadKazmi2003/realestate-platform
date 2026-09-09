'use client'

export const dynamic = 'force-dynamic';

import { useState, FormEvent } from 'react'
import { supabase } from '@/lib/supabaseClient'
import Link from 'next/link'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    // Use current origin so it works in Chrome (localhost) and VS Code browser (forwarded host)
    const redirectTo = `${window.location.origin}/reset-password`
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (resetError) {
      setError(resetError.message)
    } else {
      setSent(true)
    }
    setLoading(false)
  }

  if (sent) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg-color">
        <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color text-center">
          <h1 className="text-2xl font-bold text-text-color-dark mb-2">Check your email</h1>
          <p className="text-text-color-light mb-2">We sent a password reset link to <strong>{email}</strong>.</p>
          <p className="text-xs text-text-color-light mb-6">Local dev: view it at http://127.0.0.1:54324 (Inbucket). Production: check inbox/spam.</p>
          <button onClick={() => setSent(false)} className="text-blue-600 hover:underline text-sm">Try again</button>
          <div className="mt-4"><Link href="/sign-in" className="neumorphic-button inline-block">Back to sign in</Link></div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg-color">
      <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color">
        <Link href="/sign-in" className="text-sm text-text-color-light hover:text-text-color-dark mb-6 inline-block">← Back to sign in</Link>
        <h1 className="text-2xl font-bold text-text-color-dark mb-2">Forgot password?</h1>
        <p className="text-text-color-light text-sm mb-6">Enter your email and we will send you a reset link.</p>
        {error && <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="email" placeholder="Enter your email" value={email} onChange={e => setEmail(e.target.value)} required className="neumorphic-input w-full" />
          <button type="submit" disabled={loading} className="neumorphic-button bg-cta-gradient w-full">{loading ? 'Sending...' : 'Send reset link'}</button>
        </form>
      </div>
    </div>
  )
}
