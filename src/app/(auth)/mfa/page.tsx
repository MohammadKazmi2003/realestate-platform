'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useAuth } from '@/context/AuthContext'
import { useRouter } from 'next/navigation'
import { withAuth } from '@/utils/withAuth'
import { FaSpinner, FaTrash, FaPlus, FaCheck, FaArrowLeft, FaShieldAlt } from 'react-icons/fa'
import type { Factor } from '@supabase/supabase-js'
// @ts-expect-error — qrcode has no type declarations
import QRCode from 'qrcode'

function MfaPage() {
  const router = useRouter()
  const { user } = useAuth()
  const [factors, setFactors] = useState<Factor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Enrollment flow state
  const [enrolling, setEnrolling] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [enrollError, setEnrollError] = useState<string | null>(null)

  // Deletion state
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const fetchFactors = useCallback(async () => {
    const { data, error: factorsError } = await supabase.auth.mfa.listFactors()
    if (factorsError) {
      setError(factorsError.message)
    } else {
      setFactors(data?.all || [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchFactors()
  }, [fetchFactors])

  const handleEnroll = async () => {
    setEnrolling(true)
    setEnrollError(null)
    setVerifyCode('')
    setQrDataUrl(null)
    setFactorId(null)

    const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
    if (enrollError) {
      setEnrollError(enrollError.message)
      setEnrolling(false)
      return
    }

    setFactorId(data.id)

    // Generate QR code data URL from the otpauth:// URI
    try {
      const url = await QRCode.toDataURL(data.totp?.qr_code || '', { width: 250, margin: 2 })
      setQrDataUrl(url)
    } catch {
      setQrDataUrl(null)
    }
  }

  const handleVerify = async () => {
    if (!factorId) return
    setVerifying(true)
    setEnrollError(null)

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
    if (challengeError || !challengeData) {
      setEnrollError(challengeError?.message || 'Challenge failed')
      setVerifying(false)
      return
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId, challengeId: challengeData.id, code: verifyCode })
    if (verifyError) {
      setEnrollError(verifyError.message)
      setVerifying(false)
      return
    }

    setQrDataUrl(null)
    setFactorId(null)
    setVerifyCode('')
    setEnrolling(false)
    await fetchFactors()
  }

  const handleDelete = async (factorId: string) => {
    setDeletingId(factorId)
    setError(null)
    const { error: deleteError } = await supabase.auth.mfa.unenroll({ factorId })
    if (deleteError) {
      setError(deleteError.message)
    } else {
      await fetchFactors()
    }
    setDeletingId(null)
  }

  const verifiedFactors = factors.filter(f => f.status === 'verified')
  const unverifiedFactors = factors.filter(f => f.status !== 'verified')

  return (
    <div className="min-h-screen bg-bg-color">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <button
          onClick={() => router.push('/')}
          className="inline-flex items-center gap-1 text-sm text-text-color-light hover:text-text-color-dark mb-6 transition-colors"
        >
          <FaArrowLeft size={12} /> Back to home
        </button>

        <div className="flex items-center gap-3 mb-8">
          <FaShieldAlt className="text-2xl text-text-color-dark" />
          <div>
            <h1 className="text-2xl font-bold text-text-color-dark">Two-factor authentication</h1>
            <p className="text-sm text-text-color-light">Add an extra layer of security to your account</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <FaSpinner className="animate-spin text-2xl text-text-color-light" />
          </div>
        ) : (
          <>
            {/* Verified factors */}
            {verifiedFactors.length > 0 && (
              <div className="mb-8">
                <h2 className="text-lg font-semibold text-text-color-dark mb-3">Your authenticator apps</h2>
                <div className="space-y-2">
                  {verifiedFactors.map(factor => (
                    <div
                      key={factor.id}
                      className="flex items-center justify-between p-4 rounded-2xl shadow-neumorphic-outset bg-bg-color"
                    >
                      <div className="flex items-center gap-3">
                        <FaCheck className="text-success-color" />
                        <div>
                          <p className="font-medium text-text-color-dark">Authenticator app</p>
                          <p className="text-xs text-text-color-light">Added {new Date(factor.created_at).toLocaleDateString()}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDelete(factor.id)}
                        disabled={deletingId === factor.id}
                        className="p-2 text-danger-color hover:bg-red-50 rounded-xl transition-colors disabled:opacity-50"
                        title="Remove"
                      >
                        {deletingId === factor.id ? <FaSpinner className="animate-spin" /> : <FaTrash size={14} />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Unverified factors (enrolled but not verified) */}
            {unverifiedFactors.length > 0 && (
              <div className="mb-8">
                <h2 className="text-lg font-semibold text-text-color-dark mb-3">Pending enrollment</h2>
                {unverifiedFactors.map(factor => (
                  <div key={factor.id} className="p-4 rounded-2xl shadow-neumorphic-outset bg-bg-color">
                    <p className="text-sm text-text-color-light mb-2">
                      Factor <strong>{factor.friendly_name || factor.id.slice(0, 8)}</strong> — verify below to complete enrollment.
                    </p>
                    <button
                      onClick={() => handleDelete(factor.id)}
                      disabled={deletingId === factor.id}
                      className="text-sm text-danger-color hover:underline"
                    >
                      {deletingId === factor.id ? 'Removing...' : 'Cancel enrollment'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Enrollment form */}
            {enrolling ? (
              <div className="p-6 rounded-3xl shadow-neumorphic-outset bg-bg-color">
                <h2 className="text-lg font-semibold text-text-color-dark mb-4">Set up authenticator app</h2>

                {enrollError && (
                  <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
                    {enrollError}
                  </div>
                )}

                {qrDataUrl && (
                  <div className="mb-6 text-center">
                    <p className="text-sm text-text-color-light mb-3">
                      Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
                    </p>
                    <img src={qrDataUrl} alt="TOTP QR Code" className="mx-auto rounded-2xl shadow-neumorphic-inset" />
                  </div>
                )}

                <div className="space-y-3">
                  <input
                    type="text"
                    placeholder="Enter 6-digit code from authenticator app"
                    value={verifyCode}
                    onChange={e => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    maxLength={6}
                    className="neumorphic-input w-full text-center text-lg tracking-widest"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleVerify}
                      disabled={verifying || verifyCode.length !== 6}
                      className="neumorphic-button bg-cta-gradient flex-1 flex items-center justify-center gap-2"
                    >
                      {verifying ? <FaSpinner className="animate-spin" /> : <FaCheck />}
                      {verifying ? 'Verifying...' : 'Verify & enable'}
                    </button>
                    <button
                      onClick={() => { setEnrolling(false); setQrDataUrl(null); setFactorId(null); setVerifyCode('') }}
                      disabled={verifying}
                      className="neumorphic-button flex-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={handleEnroll}
                disabled={verifiedFactors.length >= 10}
                className="neumorphic-button w-full flex items-center justify-center gap-2"
              >
                <FaPlus size={12} />
                Add authenticator app
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default withAuth(MfaPage)
