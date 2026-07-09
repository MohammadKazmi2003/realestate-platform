'use client'

import { useState, FormEvent } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { FaSpinner, FaArrowLeft, FaSms, FaTelegramPlane } from 'react-icons/fa'

type OtpMethod = 'sms' | 'telegram'

export default function PhoneSignUpPage() {
  const router = useRouter()
  const [phone, setPhone] = useState('')
  const [method, setMethod] = useState<OtpMethod>('sms')
  const [step, setStep] = useState<'input' | 'otp'>('input')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [otpSent, setOtpSent] = useState(false)

  const handleSendOtp = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    // Validate phone: must be in full E.164 format (e.g. +919999999001)
    if (!phone.startsWith('+') || phone.length < 10) {
      setError('Enter a valid phone number with country code (e.g. +919999999001)')
      setLoading(false)
      return
    }

    if (method === 'telegram') {
      // For Telegram, we'd call the edge function to send OTP via Telegram bot.
      // For local dev, we use the same Supabase test OTP system.
      // When the edge function is deployed, it will handle actual Telegram delivery.
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/telegram-otp-bot`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone }),
          }
        )
        if (!res.ok) {
          // Fall back to SMS path if edge function isn't available (local dev)
          setMethod('sms')
        }
      } catch {
        // Edge function not available locally — fall through to SMS
        setMethod('sms')
      }
    }

    // Use Supabase phone auth (works with test OTPs in local dev)
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone })
    if (otpError) {
      setError(otpError.message)
      setLoading(false)
      return
    }

    setOtpSent(true)
    setStep('otp')
    setLoading(false)
  }

  const handleVerifyOtp = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error: verifyError } = await supabase.auth.verifyOtp({
      phone,
      token: code,
      type: 'sms',
    })

    if (verifyError) {
      setError(verifyError.message)
      setLoading(false)
      return
    }

    router.push('/')
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg-color">
      <div className="w-full max-w-md mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color">
        {step === 'input' ? (
          <>
            <Link href="/sign-up" className="inline-flex items-center gap-1 text-sm text-text-color-light hover:text-text-color-dark mb-6 transition-colors">
              <FaArrowLeft size={12} /> Back to sign up
            </Link>

            <h1 className="text-2xl font-bold text-text-color-dark mb-2">Sign up with phone</h1>
            <p className="text-text-color-light text-sm mb-6">
              Enter your phone number and choose how to receive the verification code.
            </p>

            {error && (
              <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleSendOtp} className="space-y-4">
              <input
                type="tel"
                placeholder="+919999999001"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                required
                className="neumorphic-input w-full"
                autoFocus
              />

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMethod('sms')}
                  className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-2xl text-sm font-medium transition-all ${
                    method === 'sms'
                      ? 'shadow-neumorphic-outset bg-bg-color text-blue-600'
                      : 'text-text-color-light hover:text-text-color-dark'
                  }`}
                >
                  <FaSms />
                  SMS
                </button>
                <button
                  type="button"
                  onClick={() => setMethod('telegram')}
                  className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-2xl text-sm font-medium transition-all ${
                    method === 'telegram'
                      ? 'shadow-neumorphic-outset bg-bg-color text-blue-600'
                      : 'text-text-color-light hover:text-text-color-dark'
                  }`}
                >
                  <FaTelegramPlane />
                  Telegram
                </button>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="neumorphic-button bg-cta-gradient w-full flex items-center justify-center gap-2"
              >
                {loading ? <FaSpinner className="animate-spin" /> : null}
                {loading ? 'Sending...' : 'Send verification code'}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-text-color-dark mb-2">Enter verification code</h1>
            <p className="text-text-color-light text-sm mb-2">
              We sent a code to <strong>{phone}</strong> via {method === 'sms' ? 'SMS' : 'Telegram'}.
            </p>
            <p className="text-text-color-light text-xs mb-6">
              For local development, use test code <strong>123456</strong>.
            </p>

            {error && (
              <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <input
                type="text"
                placeholder="000000"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                className="neumorphic-input w-full text-center text-2xl tracking-[0.5em]"
                autoFocus
              />
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="neumorphic-button bg-cta-gradient w-full flex items-center justify-center gap-2"
              >
                {loading ? <FaSpinner className="animate-spin" /> : null}
                {loading ? 'Verifying...' : 'Verify & sign in'}
              </button>
              <button
                type="button"
                onClick={() => { setStep('input'); setOtpSent(false); setError(null) }}
                className="neumorphic-button w-full text-sm"
              >
                Change phone number
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
