'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useAuth } from '@/context/AuthContext'

export function withAuth<P extends {}>(Component: React.ComponentType<P>) {
  return function AuthenticatedComponent(props: P) {
    const { user } = useAuth()
    const router = useRouter()

    useEffect(() => {
      if (!user) router.replace('/sign-in')
    }, [user])

    if (!user) return null // Or a full-page loader

    return <Component {...props} />
  }
}
