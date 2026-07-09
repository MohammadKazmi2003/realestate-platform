'use client'

import { useState, FormEvent, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useRouter } from 'next/navigation'
import { FaSpinner, FaCheckCircle, FaExclamationTriangle } from 'react-icons/fa'
import Link from 'next/link'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [ready, setReady] = useState(false)
  const [sessionError, setSessionError] = useState(false)

  useEffect(() => {
    // Supabase automatically processes the recovery token from the URL hash
    // and creates a session. We detect this by checking the URL hash.
    const hash = window.location.hash
    if (!hash || !hash.includes('type=recovery')) {
      setSessionError(true)
      return
    }

    supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setReady(true)
      }
    })

    // Also check if we already have a session (token already processed)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setReady(true)
      }
    })

    const timer = setTimeout(() => {
      if (!ready) {
        setSessionError(true)
      }
    }, 5000)

    return () => clearTimeout(timer)
  }, [ready])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
    } else {
      setSuccess(true)
      setLoading(false)
      setTimeout(() => router.push('/'), 2000)
    }
  }

  if (sessionError) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg-color">
        <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color text-center">
          <FaExclamationTriangle className="text-amber-500 text-5xl mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-text-color-dark mb-2">Invalid or expired link</h1>
          <p className="text-text-color-light mb-6">
            This password reset link is invalid or has expired.
          </p>
          <Link href="/forgot-password" className="text-blue-600 hover:underline font-medium">
            Request a new reset link
          </Link>
        </div>
      </div>
    )
  }

  if (success) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg-color">
        <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color text-center">
          <FaCheckCircle className="text-success-color text-5xl mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-text-color-dark mb-2">Password updated</h1>
          <p className="text-text-color-light">Redirecting you to the homepage...</p>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg-color">
        <FaSpinner className="animate-spin text-3xl text-text-color-light" />
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg-color">
      <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color">
        <h1 className="text-2xl font-bold text-text-color-dark mb-2">Set new password</h1>
        <p className="text-text-color-light text-sm mb-6">
          Enter your new password below.
        </p>

        {error && (
          <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              placeholder="New password (min. 8 characters)"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
              className="neumorphic-input w-full"
            />
          </div>
          <div>
            <input
              type="password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              className="neumorphic-input w-full"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="neumorphic-button bg-cta-gradient w-full flex items-center justify-center gap-2"
          >
            {loading ? <FaSpinner className="animate-spin" /> : null}
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  )
}
