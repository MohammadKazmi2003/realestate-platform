'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useRouter } from 'next/navigation'
import { withAuth } from '@/utils/withAuth'
import { useAuth } from '@/context/AuthContext'
import { FaSpinner, FaCheck, FaUser, FaBuilding, FaHandshake } from 'react-icons/fa'
import Link from 'next/link'

const roles = [
  { id: 4, name: 'user', label: 'General User', icon: FaUser, description: 'Browse and explore properties' },
  { id: 2, name: 'property_owner', label: 'Property Owner', icon: FaBuilding, description: 'List and manage your properties' },
  { id: 3, name: 'agent', label: 'Agent', icon: FaHandshake, description: 'Manage leads, clients, and listings' },
]

function OnboardingPage() {
  const router = useRouter()
  const { user } = useAuth()
  const [selectedRole, setSelectedRole] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleContinue = async () => {
    if (!selectedRole || !user) return
    setSaving(true)
    setError(null)

    // Use upsert so the profile is created if missing (resilience against trigger failures)
    const { error: upsertError } = await supabase
      .from('profiles')
      .upsert({
        id: user.id,
        email: user.email,
        name: (user.user_metadata as any)?.full_name || user.email?.split('@')[0] || 'User',
        role_id: selectedRole,
      })

    if (upsertError) {
      setError(upsertError.message)
      setSaving(false)
      return
    }

    // Refresh the session so the JWT gets new role claims via custom_access_token_hook
    const { error: refreshError } = await supabase.auth.refreshSession()
    if (refreshError) {
      setError(refreshError.message)
      setSaving(false)
      return
    }

    router.push('/')
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg-color">
      <div className="w-full max-w-lg mx-4 p-8 rounded-3xl shadow-neumorphic-outset bg-bg-color">
        <h1 className="text-2xl font-bold text-text-color-dark mb-2">Welcome!</h1>
        <p className="text-text-color-light text-sm mb-8">
          Tell us about yourself to get the best experience.
        </p>

        {error && (
          <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {roles.map(role => {
            const Icon = role.icon
            const isSelected = selectedRole === role.id
            return (
              <button
                key={role.id}
                onClick={() => setSelectedRole(role.id)}
                className={`w-full flex items-center gap-4 p-4 rounded-2xl text-left transition-all ${
                  isSelected
                    ? 'shadow-neumorphic-outset bg-bg-color ring-2 ring-blue-500'
                    : 'shadow-neumorphic-inset hover:shadow-neumorphic-outset'
                }`}
              >
                <div className={`p-3 rounded-xl ${isSelected ? 'bg-blue-100 text-blue-600' : 'bg-shadow-dark/5 text-text-color-light'}`}>
                  <Icon size={20} />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-text-color-dark">{role.label}</p>
                  <p className="text-xs text-text-color-light">{role.description}</p>
                </div>
                {isSelected && <FaCheck className="text-blue-600" />}
              </button>
            )
          })}
        </div>

        <button
          onClick={handleContinue}
          disabled={!selectedRole || saving}
          className="mt-8 neumorphic-button bg-cta-gradient w-full flex items-center justify-center gap-2"
        >
          {saving ? <FaSpinner className="animate-spin" /> : null}
          {saving ? 'Saving...' : 'Continue'}
        </button>

        <p className="mt-4 text-center text-xs text-text-color-light">
          You can change this later in your account settings.{' '}
          <Link href="/" className="text-blue-600 hover:underline">Skip for now</Link>
        </p>
      </div>
    </div>
  )
}

export default withAuth(OnboardingPage)
