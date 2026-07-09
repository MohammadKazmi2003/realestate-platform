'use client'

import { useState, FormEvent, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { FaSpinner, FaEnvelope, FaLock, FaShieldAlt, FaGoogle, FaApple } from 'react-icons/fa'

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // MFA challenge state
  const [mfaRequired, setMfaRequired] = useState(false)
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  const [mfaVerifying, setMfaVerifying] = useState(false)

  useEffect(() => {
    // Redirect if already signed in
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.push('/')
      }
    })
  }, [router])

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }

    // If session is null, MFA might be required
    if (!data.session) {
      // Check if user has MFA factors enrolled
      const { data: mfaData, error: mfaError } = await supabase.auth.mfa.listFactors()
      if (mfaError) {
        setError(mfaError.message)
        setLoading(false)
        return
      }

      const verifiedFactors = mfaData?.all?.filter(f => f.status === 'verified') || []
      if (verifiedFactors.length > 0) {
        setMfaFactorId(verifiedFactors[0].id)
        setMfaRequired(true)
        setLoading(false)
        return
      }
    }

    // Session exists — signed in successfully
    router.push('/')
  }

  const handleMfaVerify = async () => {
    if (!mfaFactorId) return
    setMfaVerifying(true)
    setError(null)

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: mfaFactorId })
    if (challengeError || !challengeData) {
      setError(challengeError?.message || 'Challenge failed')
      setMfaVerifying(false)
      return
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId: mfaFactorId, challengeId: challengeData.id, code: mfaCode })
    if (verifyError) {
      setError(verifyError.message)
      setMfaVerifying(false)
      return
    }

    // MFA verified — session is now active
    router.push('/')
  }

  const handleOAuthSignIn = async (provider: 'google' | 'apple') => {
    setLoading(true)
    setError(null)
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/`,
        queryParams: { prompt: 'select_account' },
      },
    })
    if (oauthError) {
      setError(oauthError.message)
      setLoading(false)
    }
  }

  // MFA challenge view
  if (mfaRequired) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg-color">
        <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color">
          <FaShieldAlt className="text-blue-600 text-3xl mb-4" />
          <h1 className="text-2xl font-bold text-text-color-dark mb-2">Two-factor authentication</h1>
          <p className="text-text-color-light text-sm mb-6">
            Enter the 6-digit code from your authenticator app.
          </p>

          {error && (
            <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <input
              type="text"
              placeholder="000000"
              value={mfaCode}
              onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              className="neumorphic-input w-full text-center text-2xl tracking-[0.5em]"
              autoFocus
              disabled={mfaVerifying}
            />
            <button
              onClick={handleMfaVerify}
              disabled={mfaVerifying || mfaCode.length !== 6}
              className="neumorphic-button bg-cta-gradient w-full flex items-center justify-center gap-2"
            >
              {mfaVerifying ? <FaSpinner className="animate-spin" /> : null}
              {mfaVerifying ? 'Verifying...' : 'Verify'}
            </button>
            <button
              onClick={() => { setMfaRequired(false); setMfaCode(''); setMfaFactorId(null); setError(null) }}
              disabled={mfaVerifying}
              className="neumorphic-button w-full text-sm"
            >
              Go back
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Default sign-in view
  return (
    <div className="flex items-center justify-center min-h-screen bg-bg-color">
      <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color">
        <h1 className="text-2xl font-bold text-text-color-dark mb-6">Sign in</h1>

        {error && (
          <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSignIn} className="space-y-4">
          <div className="relative">
            <FaEnvelope className="absolute left-3 top-1/2 -translate-y-1/2 text-text-color-light" size={14} />
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="neumorphic-input w-full pl-10"
            />
          </div>
          <div className="relative">
            <FaLock className="absolute left-3 top-1/2 -translate-y-1/2 text-text-color-light" size={14} />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="neumorphic-input w-full pl-10"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="neumorphic-button bg-cta-gradient w-full flex items-center justify-center gap-2"
          >
            {loading ? <FaSpinner className="animate-spin" /> : null}
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-shadow-dark/20" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-bg-color px-3 text-text-color-light">or continue with</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => handleOAuthSignIn('google')}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 p-3 rounded-2xl shadow-neumorphic-outset text-sm font-medium text-text-color-dark hover:shadow-[6px_6px_12px_var(--shadow-dark),-6px_-6px_12px_var(--shadow-light)] transition-all disabled:opacity-50"
          >
            <FaGoogle />
            Google
          </button>
          <button
            onClick={() => handleOAuthSignIn('apple')}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 p-3 rounded-2xl shadow-neumorphic-outset text-sm font-medium text-text-color-dark hover:shadow-[6px_6px_12px_var(--shadow-dark),-6px_-6px_12px_var(--shadow-light)] transition-all disabled:opacity-50"
          >
            <FaApple />
            Apple
          </button>
        </div>

        <div className="mt-6 text-center space-y-2">
          <Link href="/forgot-password" className="block text-sm text-blue-600 hover:underline">
            Forgot your password?
          </Link>
          <p className="text-sm text-text-color-light">
            Don&apos;t have an account?{' '}
            <Link href="/sign-up" className="text-blue-600 hover:underline font-medium">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
