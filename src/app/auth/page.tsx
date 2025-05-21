'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function AuthPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLogin, setIsLogin] = useState(true)
  const router = useRouter()

  const handleAuth = async () => {
    const authFn = isLogin ? supabase.auth.signInWithPassword : supabase.auth.signUp
    const { data, error } = await authFn({
      email,
      password
    })

    if (error) {
      alert('Error: ' + error.message)
    } else {
      alert(isLogin ? 'Login successful!' : 'Signup successful! Check your email.')
      if (isLogin) router.push('/')
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      <h1 className="text-2xl font-bold mb-4">{isLogin ? 'Login' : 'Sign Up'}</h1>
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="border p-2 mb-2 w-full max-w-sm"
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="border p-2 mb-4 w-full max-w-sm"
      />
      <button onClick={handleAuth} className="bg-blue-600 text-white px-4 py-2 rounded">
        {isLogin ? 'Login' : 'Sign Up'}
      </button>
      <p
        className="mt-4 text-blue-500 cursor-pointer"
        onClick={() => setIsLogin(!isLogin)}
      >
        {isLogin ? 'Need an account? Sign Up' : 'Already have an account? Log In'}
      </p>
    </div>
  )
}
