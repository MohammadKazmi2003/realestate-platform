'use client'

import { useState, FormEvent } from 'react'
import { supabase } from '@/lib/supabaseClient'
import Link from 'next/link'
import { FaArrowLeft, FaSpinner, FaCheckCircle } from 'react-icons/fa'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })

    if (resetError) {
      setError(resetError.message)
      setLoading(false)
    } else {
      setSent(true)
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg-color">
        <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color text-center">
          <FaCheckCircle className="text-success-color text-5xl mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-text-color-dark mb-2">Check your email</h1>
          <p className="text-text-color-light mb-6">
            We&apos;ve sent a password reset link to <strong>{email}</strong>
          </p>
          <p className="text-sm text-text-color-light">
            Didn&apos;t receive it?{' '}
            <button onClick={() => setSent(false)} className="text-blue-600 hover:underline font-medium">
              Try again
            </button>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg-color">
      <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color">
        <Link href="/sign-in" className="inline-flex items-center gap-1 text-sm text-text-color-light hover:text-text-color-dark mb-6 transition-colors">
          <FaArrowLeft size={12} /> Back to sign in
        </Link>
        <h1 className="text-2xl font-bold text-text-color-dark mb-2">Forgot password?</h1>
        <p className="text-text-color-light text-sm mb-6">
          Enter your email and we&apos;ll send you a link to reset your password.
        </p>

        {error && (
          <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="neumorphic-input w-full"
          />
          <button
            type="submit"
            disabled={loading}
            className="neumorphic-button bg-cta-gradient w-full flex items-center justify-center gap-2"
          >
            {loading ? <FaSpinner className="animate-spin" /> : null}
            {loading ? 'Sending...' : 'Send reset link'}
          </button>
        </form>
      </div>
    </div>
  )
}
