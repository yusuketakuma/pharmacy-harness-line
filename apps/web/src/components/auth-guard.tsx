'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import {
  BrowserStorageUnavailableError,
  persistStaffSession,
  SessionStateUnavailableError,
} from '@/lib/api'
import { loginRedirectPath } from '@/lib/safe-next-path'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [checked, setChecked] = useState(false)
  const [sessionSafetyError, setSessionSafetyError] = useState('')

  useEffect(() => {
    let cancelled = false

    if (pathname === '/login') {
      setChecked(true)
      return () => { cancelled = true }
    }

    // Verify the session via the HttpOnly cookie. /api/auth/session returns the
    // staff identity and refreshes the CSRF token if it was lost (e.g. reload).
    const checkSession = async () => {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL
        const res = await fetch(`${apiUrl}/api/auth/session`, { credentials: 'include' })
        if (!res.ok) throw new Error('unauthenticated')
        const data = await res.json()
        if (cancelled) return
        persistStaffSession(data)
        if (data.data.mustChangePassword) {
          if (!cancelled) router.replace('/login')
          return
        }
        setChecked(true)
      } catch (caught) {
        if (cancelled) return
        if (caught instanceof BrowserStorageUnavailableError || caught instanceof SessionStateUnavailableError) {
          setSessionSafetyError(caught instanceof BrowserStorageUnavailableError
            ? 'ブラウザの保存領域を利用できないため、安全なログイン状態を確認できません。保存領域を有効にして再読み込みしてください。'
            : '安全なセッション情報を確認できないため、保護された画面を開けません。再読み込みしてください。')
        } else {
          router.replace(loginRedirectPath())
        }
      }
    }

    checkSession()
    return () => { cancelled = true }
  }, [pathname, router])

  if (sessionSafetyError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <p role="alert" className="max-w-md text-center text-sm text-red-700">{sessionSafetyError}</p>
      </div>
    )
  }

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-[3px] border-gray-200 border-t-green-500 rounded-full" />
      </div>
    )
  }

  return <>{children}</>
}
