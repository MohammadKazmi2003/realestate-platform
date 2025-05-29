'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useAuth } from '@/context/AuthContext' // Make sure this import is correct

export function withAuth<P extends {}>(Component: React.ComponentType<P>) {
  return function AuthenticatedComponent(props: P) {
    const { user, loading } = useAuth() // Destructure loading from useAuth
    const router = useRouter()

    useEffect(() => {
      // If not loading and there's no user, then redirect to sign-in
      if (!loading && !user) {
        router.replace('/sign-in')
      }
    }, [user, loading, router]) // Add loading to dependency array

    // If still loading, display a loader or null to prevent content flicker
    if (loading) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <p className="text-xl text-gray-600">Loading authentication status...</p>
        </div>
      );
    }

    // If not loading and no user, return null (redirection handled by useEffect)
    if (!user) {
      return null;
    }

    // If authenticated, render the wrapped component
    return <Component {...props} />
  }
}
