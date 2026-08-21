'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  clearPlatformAdminLocalState,
  PlatformAdminApiError,
  platformAdminApi,
  setPlatformAdminName,
} from '@/lib/platform-admin-api'
import { SupportModeBanner } from '@/components/platform-admin/support-mode'

const NAV = [
  { href: '/platform-admin', label: 'ダッシュボード' },
  { href: '/platform-admin/tenants', label: 'テナント一覧' },
  { href: '/platform-admin/logs', label: 'ログ' },
  { href: '/platform-admin/audit', label: '自分の操作履歴' },
]

// ダッシュボードは区画のルートなので startsWith だと全ページで点灯する。
const isCurrent = (pathname: string | null, href: string) =>
  href === '/platform-admin' ? pathname === href : Boolean(pathname?.startsWith(href))

/**
 * 全体管理者セクション専用のシェル。テナント側の AuthGuard / AccountProvider /
 * Sidebar は使わない (このロールはどのテナントにも属さない)。
 * PHI を全テナント横断で読めるロールなので、どのページにも常時バナーを出す。
 */
export default function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const isLogin = pathname === '/platform-admin/login'
  const [checked, setChecked] = useState(false)
  const [name, setName] = useState('')
  const [sessionError, setSessionError] = useState('')

  useEffect(() => {
    if (isLogin) {
      setChecked(true)
      return
    }
    let cancelled = false
    setSessionError('')
    platformAdminApi.session()
      .then((res) => {
        if (!res?.success || !res?.data) throw new PlatformAdminApiError(401, 'unauthenticated')
        if (res.data.mustChangePassword) {
          if (!cancelled) router.replace('/platform-admin/login')
          return
        }
        setPlatformAdminName(res.data.name)
        if (!cancelled) {
          setName(res.data.name)
          setChecked(true)
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        if (caught instanceof PlatformAdminApiError && caught.status === 401) {
          clearPlatformAdminLocalState()
          router.replace('/platform-admin/login')
          return
        }
        setSessionError('セッション状態を確認できませんでした。通信状態を確認して再読み込みしてください。')
      })
    return () => { cancelled = true }
  }, [isLogin, router])

  const logout = async () => {
    await platformAdminApi.logout().catch(() => undefined)
    clearPlatformAdminLocalState()
    router.replace('/platform-admin/login')
  }

  if (isLogin) return <>{children}</>

  if (sessionError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-4 text-center">
        <p role="alert" className="text-sm text-red-700">{sessionError}</p>
        <button type="button" onClick={() => window.location.reload()} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          再読み込み
        </button>
      </div>
    )
  }

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-[3px] border-gray-200 border-t-purple-600 rounded-full" />
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <div role="alert" className="bg-purple-900 px-4 py-2 text-center text-sm font-bold text-white">
        全体管理者モード — 全テナントのデータ（個人の診療記録を含む）にアクセスしています。操作はすべて監査記録に残ります。
      </div>
      <SupportModeBanner />
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-purple-200 bg-white px-4 py-3">
        <span className="font-bold text-purple-900">全体管理者</span>
        <nav className="flex flex-wrap gap-3 text-sm">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={isCurrent(pathname, item.href)
                ? 'font-semibold text-purple-800 underline'
                : 'text-gray-600 hover:text-purple-800'}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {name && <span className="text-gray-600">{name}</span>}
          <button type="button" onClick={logout} className="rounded-lg border border-purple-300 px-3 py-1 text-purple-800 hover:bg-purple-50">
            ログアウト
          </button>
        </div>
      </header>
      <main className="px-4 py-6">{children}</main>
    </div>
  )
}
